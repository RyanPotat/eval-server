import Cluster from "node:cluster";

interface PotatWorkerRequest<T extends (...args: any) => any> {
  type: 'PotatWorkerRequest';
  args: Parameters<T>;
  id: number;
}

interface PotatWorkerResponse<T extends (...args: any)=> any> {
  type: 'PotatWorkerResponse';
  result?: ReturnType<T>;
  error?: Error;
  id: number;
}

type PotatRequestHandlerCallback<T extends (...args: any) => any> = (error: Error | undefined, m?: ReturnType<T> | undefined) => void;

export class PotatWorker<T extends (...args: any) => any> {
  private requestsHandler: ((
    args: Parameters<T>,
    callback: PotatRequestHandlerCallback<T>
  ) => void) | undefined;

  private id = 0;

  private queueSizeValue: { value: number } | undefined;

  public get isReady() {
    return typeof this.requestsHandler === 'function';
  }

  public get queueSize() {
    return this.queueSizeValue?.value ?? 0;
  }

  constructor(private readonly workerHandler: T, private readonly workerTimeOut: number, private readonly workerExecutionTimeout: number) {
    if (Cluster.isPrimary) {
      this.keepWorkerAlive();
    } else {
      this.worker();
    }

    this.add = this.add.bind(this);
  }

  public add(...args: Parameters<T>): Promise<ReturnType<T>> {
    if (Cluster.isWorker) {
      return this.workerHandler(...args);
    }

    let queueSizeObject: typeof this.queueSizeValue = { value: 0 };

    return new Promise<ReturnType<T>>((resolve, reject) => {
      queueSizeObject = this.queueSizeValue;
      queueSizeObject.value++;

      let tm = setTimeout(() => {
        reject(new Error('Worker execution timed out.'));
      }, this.workerExecutionTimeout);

      if (!this.isReady) {
        return reject(new Error('Worker is not ready.'));
      }

      const watcher = (error: Error | undefined, m: ReturnType<T>) => {
        if (error) {
          reject(error);
        } else {
          resolve(m);
        }
        clearTimeout(tm);
      };

      this.requestsHandler!(args, watcher);
    }).finally(() => {
      queueSizeObject.value--;
    });
  }

  private worker() {
    process.addListener('message', async (m: PotatWorkerRequest<T>) => {
      if (m.type === 'PotatWorkerRequest') {
        try {
          const result = await this.workerHandler(...(m.args ?? []));

          process.send({
            type: 'PotatWorkerResponse',
            id: m.id,
            result,
          });
        } catch (error) {
          process.send({
            type: 'PotatWorkerResponse',
            id: m.id,
            error,
          });
        }
      }
    });
  }


  private async keepWorkerAlive() {
    while (true) {
      try {
        const abortController = new AbortController();
        const worker = Cluster.fork();
        const callbacks = new Map<number, PotatRequestHandlerCallback<T>>();
        let lastRequest = 0;
        let lastResponse = 0;

        this.queueSizeValue = { value: 0 };
        this.requestsHandler = (args: Parameters<T>, callback: PotatRequestHandlerCallback<T>) => {
          const id = this.id++;

          // didn't receive a response for more than 1 minute
          if (lastRequest > lastResponse && Date.now() - lastRequest > 6e4) {
            abortController.abort();

            return callback(new Error('Worker is not responding.'), undefined);
          }

          worker.send({ type: 'PotatWorkerRequest', args, id });
          lastRequest = Date.now();

          callbacks.set(id, callback);
        }

        worker.addListener('message', (m: PotatWorkerResponse<T>) => {
          if (m.type === 'PotatWorkerResponse') {
            lastResponse = Date.now();

            const cb = callbacks.get(m.id);

            if (m.error) {
              return cb?.(m.error);
            }

            return cb?.(undefined, m.result);
          }
        });

        await new Promise<void>(async (resolve, reject) => {
          worker?.on('exit', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject('Worker exited with code ' + code);
            }
          });

          worker?.on('error', reject);

          abortController.signal.addEventListener('abort', () => {
            try {
              reject(new Error('Worker is not responding.'));
              worker.kill('SIGKILL');
            } catch (e) {
              console.error('Failed to kill worker', e);
            }
          })
        });

        this.requestsHandler = undefined;
      } catch (e) {
        console.error('Worker died', e);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.error('Forking new worker...');
    }
  }
}

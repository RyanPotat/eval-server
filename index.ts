import express, {
  Request,
  Response,
  Application,
  NextFunction,
  json,
} from "express";
import { ExternalCopy, Isolate, Reference, Copy } from "isolated-vm";
import { Agent, fetch, Pool } from 'undici';
import { Utils } from "./sandbox-utils.js";
import { timingSafeEqual } from "crypto";
import dns from "dns";
import ip from 'ip';
interface Config {
  port: number;
  auth: string;
  maxFetchConcurrency: number;
}

interface Waiter {
  code: string;
  msg: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface EvalResponse {
  data: any[];
  statusCode: number;
  duration: number;
  errors?: { message: string }[];
}

interface EvalPotatData {
  user: Record<string, any> | undefined,
  channel: Record<string, any> | undefined,
  id: string,
  timestamp: number,
  platform: string,
  isSilent: boolean,
};

new (class EvalServer {
  private server: Application;
  private config: Config;
  private queue: Waiter[] = [];
  private processing: boolean = false;
  private concurrencyCounter: number = 0;

  private readonly maxConcurrency: number;

  constructor(config: Config) {
    this.maxConcurrency = config.maxFetchConcurrency ?? 5;
    this.config = config;
    this.server = express();
    this.server.use(json());
    this.setupRoute();
  }

  private setupRoute() {
    this.server.post(
      "/eval",
      this.authenticate.bind(this),
      async (req: Request, res: Response) => {
        const start = performance.now();

        try {
          const result = await this.add(req.body.code, req.body.msg);

          res.status(200).send({
            data: [String(result)],
            statusCode: 200,
            duration: parseFloat((performance.now() - start).toFixed(4)),
          } as EvalResponse);
        } catch (e) {
          console.error(e);

          res.status(500).send({
            data: [],
            duration: parseFloat((performance.now() - start).toFixed(4)),
            errors: [{ message: "Internal server error" }],
          })
        }
      }
    );

    this.startServer();
  }

  private async add(code: string, msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.queue.length > 20) reject("Queue is full");
      this.queue.push({ code, msg, resolve, reject } as Waiter);
      this.process();
    });
  }

  private async process() {
    if (this.processing) return;

    this.processing = true;

    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next) continue;

      const { code, msg, resolve, reject } = next as Waiter;
      await this.eval(code, msg).then(resolve).catch(reject);
    }

    this.processing = false;
  }

  private async eval(code: string, msg): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        const isolate = new Isolate({ 
          memoryLimit: 8,
          onCatastrophicError: (e) => {
            reject(e);
          }
        });

        const result = await isolate
          .createContext()
          .then(async (context) => {
            const jail = context.global;

            await jail.set("global", jail.derefInto());

            /** @todo handle trimming of excess message data on application side */
            delete msg?.channel?.data?.command_stats;
            delete msg?.channel?.commands;
            delete msg?.command?.description;
            delete msg?.channel?.blocks;

            const potatData: EvalPotatData = {
              user: msg?.user,
              channel: msg?.channel,
              id: `${msg?.id ?? ""}`,
              timestamp: msg?.timestamp ?? Date.now(),
              isSilent: !!msg?.command?.silent,
              platform: msg?.platform ?? "PotatEval",
            };

            const prelude = `
              'use strict'; 

              function toString(value) {
                if (typeof value === 'string') return value;
                if (value instanceof Error) return value.constructor.name + ': ' + value.message;
                if (value instanceof Promise) return value.then(toString);
                if (Array.isArray(value)) return value.map(toString).join(', ');
                return JSON.stringify(value);
              } 

              let msg = JSON.parse(${JSON.stringify(JSON.stringify(msg))});
            `;

            await context.evalClosure(`
              global.fetch = (url, options) => $0.apply(undefined, [url, options], { 
                  arguments: { copy: true }, 
                  promise: true, 
                  result: { copy: true, promise: true } 
                })
              `,
              [new Reference(this.fetchImplement.bind(this, potatData))],
            );

            await Utils.inject(jail);

            if (/return|await/.test(code)) {
              code = prelude + `toString((async function evaluate() { ${code} })());`;

              await context.evalClosure(
                `
                evaluate = function() {
                  return $0.apply(undefined, [], { result: { promise: true } })
                }`,
                [],
                { arguments: { reference: true } }
              );
            } else {
              code = prelude + `toString(eval('${code?.replace(/[\\"']/g, "\\$&")}'))`;
            }

            return context.eval(code, { timeout: 5000, promise: true });
          })
          .catch((e) => { return '🚫 ' + e.constructor.name + ': ' + e.message; })
          .finally(() => isolate.dispose());

        this.concurrencyCounter = 0;

        resolve((result ?? null)?.slice(0, 3000));
      } catch (e) {
        reject(e);
      }
    });
  }

  private async fetchImplement(potatData: EvalPotatData, url: string, options: Record<string, any>): Promise<Copy<any>> {
    this.concurrencyCounter++;

    try {
      if (this.concurrencyCounter > this.maxConcurrency) {
        return new ExternalCopy({ 
          body: 'Too many requests.', 
          status: 429 
        }).copyInto();
      }

      const res = await fetch(url, {
        ...options ?? {},
        signal: this.timeout(),
        dispatcher: new Agent({
          connect: {
            lookup: this.dnsLookup.bind(this),
          },
          factory: this.dispatcherFactory.bind(this),
        }),
        headers: {
          ...options?.headers ?? {},
          'User-Agent': 'Sandbox Unsafe JavaScript Execution Environment - https://github.com/RyanPotat/eval-server/',
          'x-potat-data': JSON.stringify(potatData),
        }
      })

      return new ExternalCopy({ 
        body: await this.parseBlob(await res.blob()), status: res.status 
      }).copyInto();
    } catch (e) {
      // Promise aborted by timeout.
      if (e.constructor.name === 'DOMException') {
        return new ExternalCopy({ 
          body: 'Request timed out.', 
          status: 408 
        }).copyInto();
      }
      return new ExternalCopy({
        body: `Request failed - ${e.constructor.name}: ${e.cause ?? e.message}`,
        status: 400
      }).copyInto();
    } finally {
      this.concurrencyCounter--;
    }
  }

  private timeout() {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    return controller.signal;
  }

  private dnsLookup(hostname: string, options: dns.LookupOptions, cb: (e: Error | null, address?: string | dns.LookupAddress[], family?: number) => void) {
    dns.lookup(hostname, options, (err, addr, fam) => {
      if (err !== null) {
        return cb(err);
      }

      const addresses = Array.isArray(addr) ? addr : [addr];

      try {
        for (const lookupAddress of addresses) {
          const value = typeof lookupAddress === 'string' ? lookupAddress : lookupAddress.address;

          this.throwIfPrivateIP(value);
        }
      } catch (e) {
        return cb(e);
      }

      cb(null, addr, fam);
    });
  }

  private dispatcherFactory(origin: string, options: Pool.Options) {
    const url = new URL(origin);

    if (ip.isV4Format(url.hostname) || ip.isV6Format(url.hostname)) {
      this.throwIfPrivateIP(url.hostname);
    }

    return new Pool(origin, options);
  }

  private throwIfPrivateIP(i: string) {
    if (ip.isPrivate(i)) {
      throw new Error(`Access to ${i} is disallowed`);
    }
  }

  private async parseBlob(blob: Blob): Promise<string> {
    let data: any;
    try { data = JSON.parse(await blob.text()); } 
    catch { data = await blob.text(); }
    return data;
  }

  private authenticate(req: Request, res: Response, next: NextFunction) {
    const posessed = Buffer.alloc(5, this.config.auth)
    const provided = Buffer.alloc(5, req.headers.authorization?.replace("Bearer ", ""))

    if (!timingSafeEqual(posessed, provided)) {
      return res.status(418).send({
        data: [],
        statusCode: 418,
        duration: 0,
        errors: [{ message: "not today my little bish xqcL" }],
      } as EvalResponse);
    }

    next();
  }

  private startServer() {
    this.server.listen(this.config.port, () => {
      console.log(`Server listening on port ${this.config.port}`);
    });
  }
})(require("./config.json"));

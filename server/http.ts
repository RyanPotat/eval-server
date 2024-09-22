import http from 'node:http';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from "node:crypto";
import express, {
  Request,
  Response,
  Application,
  NextFunction,
  json,
} from "express";
import { EvalRequestHandler, EvalResponse } from './types.js';

export class EvalServer extends EventEmitter {
  private server: Application;

  public constructor(
    private readonly authToken: string,
    private readonly handleEvalRequest: EvalRequestHandler,
  ) {
    super();

    this.server = express();
    this.server.use(json());
    this.setupRoute();
  }

  private setupRoute() {
    this.server.post(
      "/eval",
      this.authenticate.bind(this),
      async (req: Request, res: Response) => {
        const response = await this.handleEvalRequest(req.body.code, req.body.msg);

        return res.status(response.statusCode).send(response);
      }
    );
  }

  private authenticate(req: Request, res: Response, next: NextFunction) {
    const posessed = Buffer.alloc(5, this.authToken)
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

  public listen(port: number, callback?: () => void): http.Server {
    return this.server.listen(port, callback);
  }
}

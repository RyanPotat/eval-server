import * as http from 'node:http';
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from 'ws';
import { EvalRequestHandler } from './types';

enum EventCodes {
  RECIEVED_DATA = 4000,
  RECONNECT = 4001,
  UNKNOWN_ERROR = 4002,
  INVALID_ORIGIN = 4003,
  DISPATCH = 4004,
  HEARTBEAT = 4005,
  MALFORMED_DATA = 4006,
  UNAUTHORIZED = 4007
}

interface EvalMessage {
  code: string;
  msg?: string;
  id: number;
}

interface EvalWebSocket extends WebSocket {
  _pingInterval: NodeJS.Timeout;
}

export class EvalSocket {
  private ws: WebSocketServer;

  public constructor(
    server: http.Server,
    private readonly authToken: string,
    private readonly handleEvalRequest: EvalRequestHandler,
  ) {
    this.ws = new WebSocketServer({
      server: server,
      path: '/socket'
    });

    this.ws.on('connection', (client: EvalWebSocket, req: http.IncomingMessage) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const token = url.searchParams.get('auth');

      if (!token || !this.validateToken(token)) {
        console.error('Unauthorized socket connection.', token);
        return client.close(EventCodes.UNAUTHORIZED, 'Unauthorized');
      }

      this.setupListeners(client);
    })
  }

  private setupListeners(client: EvalWebSocket): void {
    client.on('message', async (msg: MessageEvent) => {
      let data: EvalMessage;
      try { data = JSON.parse(msg.toString()); }
      catch (e) {
        return this.send(
          client,
          { error: 'Malformed JSON received.' },
          EventCodes.MALFORMED_DATA
        );
      }

      const response = await this.handleEvalRequest(data.code, data.msg);
      this.send(client, {
        ...response,
        id: data.id,
      }, EventCodes.DISPATCH);
    });

    client.on('error', () => {
      client.close(
        EventCodes.UNKNOWN_ERROR,
        'An unknown error occurred.'
      );
    });

    client._pingInterval = setInterval(() => {
      this.send(
        client,
        { timestamp: Date.now(), message: this.pickMessage() },
        EventCodes.HEARTBEAT
      )
    }, 30_000);
  }

  private send(client: EvalWebSocket, data: any, op: EventCodes): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          opcode: op ?? EventCodes.DISPATCH,
          data
        })
      );
    }
  }

  private validateToken(auth: string): boolean {
    const posessed = Buffer.alloc(5, this.authToken);
    const provided = Buffer.alloc(5, auth);

    return timingSafeEqual(posessed, provided);
  }

  /** Extremely critical */
  private pickMessage(): string {
    const messages = [
      'Skibidy toilet!!',
      'fortniteburger.net',
      'amongus.............',
      'LOL',
      'You are in a maze of twisty little passages, all alike',
      'I am a fish',
      'potatos are actually vegetables did you know this, have you heard about this?'
    ];

    return messages[Math.floor(Math.random() * messages.length)];
  }
}

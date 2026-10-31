/**
 * Локальный HTTP-сервер состояния и снимка кадра.
 *
 * Зачем нужен: без снимка проверять вёрстку можно только через регистратор,
 * а это медленно и неточно. Состояние нужно, чтобы понять, идёт ли публикация,
 * не подключаясь к потоку.
 *
 * Сервер сознательно минимален: два GET-маршрута, без зависимостей.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface HealthSnapshot {
  readonly streaming: boolean;
  readonly lastFrameAt: string | undefined;
  readonly restarts: number;
  readonly stale: boolean;
  readonly dataAgeMinutes: number | undefined;
  readonly lastError: string | undefined;
  readonly ticks: number;
  readonly dropped: number;
}

export interface HealthServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly snapshot: () => HealthSnapshot;
  /** PNG-снимок текущего кадра: генерируется по требованию. */
  readonly png: () => Promise<Uint8Array> | Uint8Array;
}

export interface HealthServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const host = options.host ?? '127.0.0.1';

  const server: Server = createServer((request, response) => {
    handle(request, response, options).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port,
    url: `http://${host}:${port}`,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Метод не поддерживается' });
    return;
  }

  switch (url.pathname) {
    case '/health': {
      sendJson(response, 200, options.snapshot());
      return;
    }
    case '/snapshot.png': {
      const png = await options.png();
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
        'cache-control': 'no-store',
      });
      response.end(Buffer.from(png));
      return;
    }
    default: {
      sendJson(response, 404, { error: 'Не найдено' });
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

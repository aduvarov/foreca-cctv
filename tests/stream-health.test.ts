import { describe, expect, it } from 'vitest';

import { startHealthServer } from '../src/stream/health.js';
import type { HealthSnapshot } from '../src/stream/health.js';

const snapshot: HealthSnapshot = {
  streaming: true,
  lastFrameAt: '2026-10-31T10:30:00.000Z',
  restarts: 2,
  stale: false,
  dataAgeMinutes: 5,
  lastError: undefined,
  ticks: 120,
  dropped: 0,
};

describe('startHealthServer', () => {
  async function withServer(
    handler: (baseUrl: string) => Promise<void>,
    png: () => Uint8Array | Promise<Uint8Array> = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  ): Promise<void> {
    const server = await startHealthServer({
      port: 0,
      snapshot: () => snapshot,
      png,
    });
    try {
      await handler(server.url);
    } finally {
      await server.close();
    }
  }

  it('отдаёт состояние на /health', async () => {
    await withServer(async (url) => {
      const response = await fetch(`${url}/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const body = (await response.json()) as HealthSnapshot;
      expect(body.streaming).toBe(true);
      expect(body.restarts).toBe(2);
      expect(body.ticks).toBe(120);
      // Состояние не кэшируется: иначе мониторинг увидит устаревшее значение.
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  it('отдаёт PNG на /snapshot.png', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await withServer(
      async (url) => {
        const response = await fetch(`${url}/snapshot.png`);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('content-length')).toBe(String(png.byteLength));

        const body = new Uint8Array(await response.arrayBuffer());
        expect([...body]).toEqual([...png]);
      },
      () => png,
    );
  });

  it('отдаёт 404 на неизвестный путь', async () => {
    await withServer(async (url) => {
      const response = await fetch(`${url}/неизвестно`);
      expect(response.status).toBe(404);
    });
  });

  it('отдаёт 405 на не-GET', async () => {
    await withServer(async (url) => {
      const response = await fetch(`${url}/health`, { method: 'POST' });
      expect(response.status).toBe(405);
    });
  });

  it('сообщает об ошибке генерации снимка кодом 500', async () => {
    await withServer(
      async (url) => {
        const response = await fetch(`${url}/snapshot.png`);
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        expect(body.error).toContain('кадр');
      },
      () => Promise.reject(new Error('кадр не готов')),
    );
  });

  it('закрывается корректно', async () => {
    const server = await startHealthServer({
      port: 0,
      snapshot: () => snapshot,
      png: () => new Uint8Array(),
    });

    await server.close();

    // После закрытия запрос должен упасть на уровне сети.
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });
});

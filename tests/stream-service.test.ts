import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceConfig } from '../src/config/schema.js';
import type { ForecastStep, ForecaClient, LocationInfo } from '../src/foreca/client.js';
import { networkError } from '../src/foreca/errors.js';
import { startService } from '../src/stream/service.js';
import type { Logger } from '../src/stream/service.js';
import type { HealthServer } from '../src/stream/health.js';
import type { EncoderSupervisor } from '../src/stream/supervisor.js';
import type { WriteResult } from '../src/stream/encoder.js';

/** Без повторов: тесты не должны ждать секунды экспоненциальных задержек. */
const instantRetry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 };

const location: LocationInfo = {
  id: 1,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: 'Asia/Almaty',
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

function steps(from: string, count: number): ForecastStep[] {
  const start = new Date(from).getTime();
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(start + index * 3 * 60 * 60 * 1000).toISOString(),
    temperature: 4,
    symbol: 'd200',
    precipAccum: 0,
    windDir: 200,
    windSpeed: 3,
    cloudiness: 40,
  }));
}

function config(cacheDir: string): ServiceConfig {
  return {
    forecaToken: 'token',
    location: {
      name: 'Караганда',
      lat: 49.8047,
      lon: 73.1094,
      timezone: 'Asia/Almaty',
    },
    stream: {
      fps: 1,
      bitrateKbps: 400,
      width: 640,
      height: 480,
      rtspUrl: 'rtsp://127.0.0.1:8554/weather',
    },
    api: {
      baseUrl: 'https://weatherapi.foreca.net',
      refreshMinutes: 30,
      timeoutMs: 5_000,
      staleAfterMinutes: 90,
    },
    state: { cacheDir, healthPort: 0, healthHost: '127.0.0.1' },
  };
}

function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`INFO ${message}`),
    warn: (message) => lines.push(`WARN ${message}`),
    error: (message) => lines.push(`ERROR ${message}`),
  };
}

/** Заглушка health-сервера: HTTP-часть проверяется отдельным тестом. */
function stubHealthServer(): { server: HealthServer; closed: () => number } {
  let closes = 0;
  return {
    server: {
      port: 0,
      url: 'http://127.0.0.1:0',
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    },
    closed: () => closes,
  };
}

function fakeSupervisor(running = true): {
  supervisor: EncoderSupervisor;
  frames: Uint8Array[];
  stop: ReturnType<typeof vi.fn>;
} {
  const frames: Uint8Array[] = [];
  const stop = vi.fn(() => Promise.resolve());
  const supervisor = {
    start: vi.fn(),
    write: vi.fn((frame: Uint8Array): WriteResult => {
      frames.push(frame);
      return { ok: true, backpressure: false };
    }),
    noteHealthy: vi.fn(),
    stop,
    state: {
      running,
      restarts: 0,
      lastFrameAt: new Date(),
      lastError: undefined,
      stopped: false,
    },
  } as unknown as EncoderSupervisor;

  return { supervisor, frames, stop };
}

function client(fetches: () => Promise<{ steps: ForecastStep[] }>): ForecaClient {
  return {
    getThreeHourlyForecast: fetches,
    getLocation: () => Promise.resolve(location),
    searchLocations: () => Promise.resolve([location]),
  } as unknown as ForecaClient;
}

describe('startService', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-service-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('запускает публикацию и отдаёт состояние', async () => {
    const health = stubHealthServer();
    const fake = fakeSupervisor();

    const service = await startService({
      config: config(directory),
      client: client(() => Promise.resolve({ steps: steps('2026-10-31T03:00:00Z', 64) })),
      now: () => new Date('2026-10-31T10:40:00Z'),
      logger: silentLogger(),
      createSupervisorImpl: () => fake.supervisor,
      startHealthServerImpl: () => Promise.resolve(health.server),
    });

    expect(service.health.streaming).toBe(true);

    await service.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(health.closed()).toBe(1);
  });

  it('не падает, если обновление прогноза не удалось', async () => {
    const health = stubHealthServer();
    const logger = silentLogger();
    const fake = fakeSupervisor();

    const service = await startService({
      config: config(directory),
      client: client(() => Promise.reject(networkError(new Error('нет сети')))),
      now: () => new Date('2026-10-31T10:40:00Z'),
      logger,
      createSupervisorImpl: () => fake.supervisor,
      startHealthServerImpl: () => Promise.resolve(health.server),
      retryPolicy: instantRetry,
    });

    // Ждём завершения стартового обновления: оно идёт в фоне.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Сервис работает: без данных кадр всё равно публикуется.
    expect(service.health.streaming).toBe(true);
    expect(logger.lines.some((line) => line.includes('не удалось'))).toBe(true);

    await service.stop();
  });

  it('публикует кадр «нет данных», когда прогноза нет', async () => {
    const health = stubHealthServer();
    const fake = fakeSupervisor();

    const service = await startService({
      config: config(directory),
      client: client(() => Promise.reject(networkError(new Error('нет сети')))),
      now: () => new Date('2026-10-31T10:40:00Z'),
      logger: silentLogger(),
      createSupervisorImpl: () => fake.supervisor,
      startHealthServerImpl: () => Promise.resolve(health.server),
      retryPolicy: instantRetry,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(fake.frames.length).toBeGreaterThan(0);
    // Кадр 640x480 RGBA.
    expect(fake.frames[0]?.length).toBe(640 * 480 * 4);

    await service.stop();
  });

  it('останавливается идемпотентно', async () => {
    const health = stubHealthServer();
    const fake = fakeSupervisor();

    const service = await startService({
      config: config(directory),
      client: client(() => Promise.resolve({ steps: steps('2026-10-31T03:00:00Z', 64) })),
      now: () => new Date('2026-10-31T10:40:00Z'),
      logger: silentLogger(),
      createSupervisorImpl: () => fake.supervisor,
      startHealthServerImpl: () => Promise.resolve(health.server),
    });

    await service.stop();
    await service.stop();

    // Health-сервер закрыт ровно один раз: повторная остановка безопасна.
    expect(health.closed()).toBe(1);
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it('сохраняет прогноз в кэш и переиспользует его при старте', async () => {
    const health = stubHealthServer();
    const fake = fakeSupervisor();

    const service = await startService({
      config: config(directory),
      client: client(() => Promise.resolve({ steps: steps('2026-10-31T03:00:00Z', 64) })),
      now: () => new Date('2026-10-31T10:40:00Z'),
      logger: silentLogger(),
      createSupervisorImpl: () => fake.supervisor,
      startHealthServerImpl: () => Promise.resolve(health.server),
    });
    await service.stop();

    const logger = silentLogger();
    const second = await startService({
      config: config(directory),
      client: client(() => Promise.reject(networkError(new Error('нет сети')))),
      now: () => new Date('2026-10-31T10:40:00Z'),
      logger,
      createSupervisorImpl: () => fakeSupervisor().supervisor,
      startHealthServerImpl: () => Promise.resolve(stubHealthServer().server),
      retryPolicy: instantRetry,
    });

    expect(logger.lines.some((line) => line.includes('из кэша'))).toBe(true);
    await second.stop();
  });
});

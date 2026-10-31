import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWeekChart } from '../src/domain/week-chart.js';
import { ForecastCache } from '../src/foreca/cache.js';
import type { ForecaClient, LocationInfo, ThreeHourlyForecast } from '../src/foreca/client.js';
import { networkError } from '../src/foreca/errors.js';
import { ForecastScheduler } from '../src/foreca/scheduler.js';

const location: LocationInfo = {
  id: 100184745,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: 'Asia/Almaty',
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

const STALE_AFTER_MS = 90 * 60_000;

function forecastFrom(startIso: string, count: number): ThreeHourlyForecast {
  const start = new Date(startIso).getTime();
  return {
    steps: Array.from({ length: count }, (_, index) => ({
      time: new Date(start + index * 3 * 60 * 60 * 1000).toISOString(),
      temperature: 3 + (index % 5),
      symbol: 'd200',
      precipAccum: 0,
      windDir: 200,
      windSpeed: 2,
      cloudiness: 30,
    })),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('Планировщик и модель вместе', () => {
  let directory: string;
  let cache: ForecastCache;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-int-'));
    cache = new ForecastCache({ directory });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function makeScheduler(options: {
    fetch: () => Promise<{ forecast: ThreeHourlyForecast; attempts: number }>;
    now: () => Date;
    intervalMs?: number;
  }): ForecastScheduler {
    return new ForecastScheduler(
      {
        client: { getLocation: vi.fn() } as unknown as ForecaClient,
        cache,
        location,
        now: options.now,
        fetchThreeHourly: options.fetch,
      },
      { intervalMs: options.intervalMs ?? 30 * 60_000 },
    );
  }

  function chartFromCurrent(scheduler: ForecastScheduler, now: Date) {
    const current = scheduler.current;
    return buildWeekChart({
      location,
      steps: current?.steps ?? [],
      now,
      updatedAt: new Date(current?.fetchedAt ?? now.toISOString()),
      staleAfterMs: STALE_AFTER_MS,
    });
  }

  it('при недоступной Foreca отдаёт прежнюю модель с признаком устаревания', async () => {
    let now = new Date('2026-10-31T10:00:00Z');
    let fail = false;

    const scheduler = makeScheduler({
      now: () => now,
      fetch: () => {
        if (fail) return Promise.reject(networkError(new Error('нет сети')));
        return Promise.resolve({ forecast: forecastFrom('2026-10-31T09:00:00Z', 64), attempts: 1 });
      },
    });

    await scheduler.refresh();
    const fresh = chartFromCurrent(scheduler, now);
    expect(fresh.days.length).toBeGreaterThan(0);
    expect(fresh.stale).toBe(false);

    // Прошло три часа, сеть пропала.
    now = new Date('2026-10-31T13:00:00Z');
    fail = true;
    const failed = await scheduler.refresh();
    expect(failed.ok).toBe(false);
    expect(failed.fromCache).toBe(true);

    const degraded = chartFromCurrent(scheduler, now);

    // Данные в кэше те же, но помечены как устаревшие — это и увидит оператор.
    // Окно отрисовки при этом сдвинулось вперёд вместе с текущим временем.
    expect(degraded.days.length).toBeGreaterThan(0);
    expect(degraded.stale).toBe(true);
    expect(degraded.ageMinutes).toBe(180);
    expect(scheduler.current?.fetchedAt).toBe(fresh.updatedAt.toISOString());
  });

  it('поднимает вещание из кэша, когда сети нет вообще', async () => {
    // Кэш записан в прошлый запуск, три часа назад.
    await cache.write({
      version: 1,
      fetchedAt: '2026-10-31T07:00:00.000Z',
      location,
      steps: forecastFrom('2026-10-31T09:00:00Z', 64).steps,
    });

    const now = new Date('2026-10-31T10:00:00Z');
    const scheduler = makeScheduler({
      now: () => now,
      fetch: () => Promise.reject(networkError(new Error('нет сети'))),
    });

    await scheduler.loadCache();
    const result = await scheduler.refresh();

    expect(result.ok).toBe(false);
    const chart = chartFromCurrent(scheduler, now);
    expect(chart.days.length).toBeGreaterThan(0);
    expect(chart.stale).toBe(true);
  });

  it('расписание вызывает обновление по интервалу и останавливается', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ forecast: forecastFrom('2026-10-31T09:00:00Z', 64), attempts: 1 }),
    );
    const scheduler = makeScheduler({
      now: () => new Date('2026-10-31T10:00:00Z'),
      fetch: fetchSpy,
      intervalMs: 20,
    });

    scheduler.start();
    expect(fetchSpy).not.toHaveBeenCalled();

    await wait(60);
    const afterStart = fetchSpy.mock.calls.length;
    expect(afterStart).toBeGreaterThanOrEqual(2);

    scheduler.stop();
    await wait(60);
    expect(fetchSpy.mock.calls.length).toBe(afterStart);
  });

  it('расписание не создаёт параллельных запросов', async () => {
    let release: (() => void) | undefined;
    let call = 0;

    const fetchSpy = vi.fn(() => {
      call += 1;
      if (call > 1) {
        return Promise.resolve({
          forecast: forecastFrom('2026-10-31T09:00:00Z', 64),
          attempts: 1,
        });
      }
      // Первый запрос висит, пока тест его не отпустит.
      return new Promise<{ forecast: ThreeHourlyForecast; attempts: number }>((resolve) => {
        release = () => {
          resolve({ forecast: forecastFrom('2026-10-31T09:00:00Z', 64), attempts: 1 });
        };
      });
    });

    const scheduler = makeScheduler({
      now: () => new Date('2026-10-31T10:00:00Z'),
      fetch: fetchSpy,
      intervalMs: 20,
    });
    scheduler.start();

    await wait(80);
    // Сколько бы тиков ни прошло, второго запроса нет: первый ещё висит.
    expect(fetchSpy).toHaveBeenCalledOnce();

    release?.();
    await wait(80);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    scheduler.stop();
  });
});

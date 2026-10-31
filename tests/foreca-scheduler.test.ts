import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForecastCache } from '../src/foreca/cache.js';
import type { CachedForecast } from '../src/foreca/cache.js';
import type { ForecaClient, LocationInfo, ThreeHourlyForecast } from '../src/foreca/client.js';
import { networkError } from '../src/foreca/errors.js';
import { EmptyForecastError, ForecastScheduler, formatLocation } from '../src/foreca/scheduler.js';
import type { RefreshResult } from '../src/foreca/scheduler.js';

const location: LocationInfo = {
  id: 100184745,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: 'Asia/Almaty',
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

const forecast: ThreeHourlyForecast = {
  steps: [
    {
      time: '2026-10-31T12:00:00.000Z',
      temperature: 4,
      symbol: 'd200',
      precipAccum: 0,
      windDir: 200,
      windSpeed: 3,
      cloudiness: 40,
    },
  ],
};

describe('formatLocation', () => {
  it('ставит долготу перед широтой', () => {
    expect(formatLocation(location)).toBe('73.1094,49.8047');
  });

  it('использует идентификатор, если координат нет', () => {
    expect(formatLocation({ ...location, lon: undefined, lat: undefined })).toBe('100184745');
  });

  it('падает обратно на название', () => {
    expect(formatLocation({ ...location, id: undefined, lon: undefined, lat: undefined })).toBe(
      'Караганда',
    );
  });
});

describe('ForecastScheduler', () => {
  let directory: string;
  let cache: ForecastCache;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-sched-'));
    cache = new ForecastCache({ directory });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function makeScheduler(
    overrides: {
      fetch?: () => Promise<{ forecast: ThreeHourlyForecast; attempts: number }>;
      client?: Partial<ForecaClient>;
      now?: () => Date;
      onRefreshed?: (result: RefreshResult) => void;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    const fetchThreeHourly = overrides.fetch ?? (() => Promise.resolve({ forecast, attempts: 1 }));
    const client = { getLocation: vi.fn() } as unknown as ForecaClient;
    Object.assign(client, overrides.client ?? {});

    return new ForecastScheduler(
      {
        client,
        cache,
        location,
        now: overrides.now ?? (() => new Date('2026-10-31T10:40:00Z')),
        fetchThreeHourly,
      },
      {
        intervalMs: 60_000,
        ...(overrides.onRefreshed === undefined ? {} : { onRefreshed: overrides.onRefreshed }),
        ...(overrides.onError === undefined ? {} : { onError: overrides.onError }),
      },
    );
  }

  it('сохраняет успешный прогноз в память и на диск', async () => {
    const scheduler = makeScheduler();

    const result = await scheduler.refresh();

    expect(result.ok).toBe(true);
    expect(scheduler.current?.steps).toHaveLength(1);
    expect((await cache.read())?.steps).toHaveLength(1);
  });

  it('не считает пустой прогноз успехом и не трогает кэш', async () => {
    const scheduler = makeScheduler({
      fetch: () => Promise.resolve({ forecast: { steps: [] }, attempts: 1 }),
    });

    const result = await scheduler.refresh();

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(EmptyForecastError);
    expect(await cache.read()).toBeUndefined();
  });

  it('сохраняет прежний прогноз при ошибке обновления', async () => {
    let shouldFail = false;
    const scheduler = makeScheduler({
      fetch: () => {
        if (shouldFail) return Promise.reject(networkError(new Error('нет сети')));
        return Promise.resolve({ forecast, attempts: 1 });
      },
    });

    await scheduler.refresh();
    shouldFail = true;
    const failed = await scheduler.refresh();

    expect(failed.ok).toBe(false);
    expect(failed.fromCache).toBe(true);
    expect(scheduler.current?.steps).toHaveLength(1);
  });

  it('не запускает второй запрос, пока идёт первый', async () => {
    let resolveFetch:
      ((value: { forecast: ThreeHourlyForecast; attempts: number }) => void) | undefined;
    const fetchThreeHourly = vi.fn(
      () =>
        new Promise<{ forecast: ThreeHourlyForecast; attempts: number }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const scheduler = makeScheduler({ fetch: fetchThreeHourly });

    const first = scheduler.refresh();
    const second = scheduler.refresh();
    // refresh асинхронный: даём микро- и макрозадачам прокрутиться,
    // чтобы вызов дошёл до fetchThreeHourly.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduler.isRefreshing).toBe(true);
    expect(fetchThreeHourly).toHaveBeenCalledOnce();

    resolveFetch?.({ forecast, attempts: 1 });
    await Promise.all([first, second]);
    expect(fetchThreeHourly).toHaveBeenCalledOnce();
  });

  it('поднимает прогноз из кэша до первого запроса', async () => {
    const cached: CachedForecast = {
      version: 1,
      fetchedAt: '2026-10-31T09:00:00.000Z',
      location,
      steps: forecast.steps,
    };
    await cache.write(cached);

    const scheduler = makeScheduler();
    await scheduler.loadCache();

    expect(scheduler.current?.fetchedAt).toBe('2026-10-31T09:00:00.000Z');
  });

  it('не падает, если кэш повреждён', async () => {
    await cache.write({
      version: 1,
      fetchedAt: 'битая дата',
      location,
      steps: [],
    });

    const scheduler = makeScheduler();
    await expect(scheduler.loadCache()).resolves.toBeUndefined();
    expect(scheduler.current).toBeUndefined();
  });

  it('не запрашивает метаданные, если имя и пояс уже известны', async () => {
    const getLocation = vi.fn();
    const scheduler = new ForecastScheduler(
      {
        client: { getLocation } as unknown as ForecaClient,
        cache,
        location,
        now: () => new Date('2026-10-31T10:40:00Z'),
        fetchThreeHourly: () => Promise.resolve({ forecast, attempts: 1 }),
      },
      { intervalMs: 60_000 },
    );

    await scheduler.refresh();

    expect(getLocation).not.toHaveBeenCalled();
  });

  it('запрашивает метаданные, если пояс неизвестен', async () => {
    const getLocation = vi.fn().mockResolvedValue(location);
    // Локация без пояса: без запроса метаданных рендер не узнает зону.
    const scheduler = new ForecastScheduler(
      {
        client: { getLocation } as unknown as ForecaClient,
        cache,
        location: { ...location, timezone: undefined },
        now: () => new Date('2026-10-31T10:40:00Z'),
        fetchThreeHourly: () => Promise.resolve({ forecast, attempts: 1 }),
      },
      { intervalMs: 60_000 },
    );

    const result = await scheduler.refresh();

    expect(getLocation).toHaveBeenCalledOnce();
    expect(result.location.timezone).toBe('Asia/Almaty');
  });

  it('продолжает работу с фолбэком, если метаданные недоступны', async () => {
    const getLocation = vi.fn().mockRejectedValue(networkError(new Error('нет сети')));
    const scheduler = new ForecastScheduler(
      {
        client: { getLocation } as unknown as ForecaClient,
        cache,
        location: { ...location, timezone: undefined },
        now: () => new Date('2026-10-31T10:40:00Z'),
        fetchThreeHourly: () => Promise.resolve({ forecast, attempts: 1 }),
      },
      { intervalMs: 60_000 },
    );

    const result = await scheduler.refresh();

    expect(result.ok).toBe(true);
    expect(result.location.name).toBe('Караганда');
  });

  it('вызывает onError при неудаче и onRefreshed при успехе', async () => {
    const onError = vi.fn();
    const onRefreshed = vi.fn();
    let shouldFail = true;

    const scheduler = makeScheduler({
      fetch: () => {
        if (shouldFail) return Promise.reject(networkError(new Error('нет сети')));
        return Promise.resolve({ forecast, attempts: 1 });
      },
      onError,
      onRefreshed,
    });

    await scheduler.refresh();
    expect(onError).toHaveBeenCalledOnce();
    expect(onRefreshed).not.toHaveBeenCalled();

    shouldFail = false;
    await scheduler.refresh();
    expect(onRefreshed).toHaveBeenCalledOnce();
  });

  it('останавливает расписание', () => {
    const scheduler = makeScheduler();
    scheduler.start();
    scheduler.stop();
    // Повторный запуск после остановки не должен включать таймер.
    scheduler.start();
    expect(scheduler.isRefreshing).toBe(false);
  });
});

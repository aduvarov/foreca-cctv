import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CACHE_VERSION, ForecastCache } from '../src/foreca/cache.js';
import type { CachedForecast } from '../src/foreca/cache.js';

const forecast: CachedForecast = {
  version: CACHE_VERSION,
  fetchedAt: '2026-10-31T10:30:00.000Z',
  location: {
    id: 1,
    name: 'Караганда',
    country: 'Казахстан',
    timezone: 'Asia/Almaty',
    adminArea: 'Карагандинская область',
    lon: 73.1094,
    lat: 49.8047,
  },
  steps: [
    {
      time: '2026-10-31T12:00:00.000Z',
      temperature: 4.2,
      symbol: 'd200',
      precipAccum: 0.1,
      windDir: 210,
      windSpeed: 3.2,
      cloudiness: 40,
    },
  ],
};

describe('ForecastCache', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-cache-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('возвращает undefined, если файла нет', async () => {
    const cache = new ForecastCache({ directory });
    await expect(cache.read()).resolves.toBeUndefined();
  });

  it('сохраняет и читает прогноз', async () => {
    const cache = new ForecastCache({ directory });

    await cache.write(forecast);
    const read = await cache.read();

    expect(read).toEqual(forecast);
  });

  it('не оставляет временных файлов после записи', async () => {
    const cache = new ForecastCache({ directory });
    await cache.write(forecast);

    const entries = await readdir(directory);
    expect(entries).toEqual(['forecast.json']);
  });

  it('игнорирует повреждённый JSON', async () => {
    const cache = new ForecastCache({ directory });
    await writeFile(cache.path, '{ это не json', 'utf8');

    await expect(cache.read()).resolves.toBeUndefined();
  });

  it('игнорирует чужую версию формата', async () => {
    const cache = new ForecastCache({ directory });
    await writeFile(cache.path, JSON.stringify({ ...forecast, version: 999 }), 'utf8');

    await expect(cache.read()).resolves.toBeUndefined();
  });

  it('игнорирует запись без локации или шагов', async () => {
    const cache = new ForecastCache({ directory });

    await writeFile(cache.path, JSON.stringify({ version: CACHE_VERSION }), 'utf8');
    await expect(cache.read()).resolves.toBeUndefined();

    await writeFile(
      cache.path,
      JSON.stringify({ version: CACHE_VERSION, fetchedAt: forecast.fetchedAt, steps: [] }),
      'utf8',
    );
    await expect(cache.read()).resolves.toBeUndefined();
  });

  it('отбрасывает непригодные шаги, но сохраняет остальные', async () => {
    const cache = new ForecastCache({ directory });
    await writeFile(
      cache.path,
      JSON.stringify({
        ...forecast,
        steps: [forecast.steps[0], { temperature: 'нет времени' }, null],
      }),
      'utf8',
    );

    const read = await cache.read();
    expect(read?.steps).toHaveLength(1);
  });

  it('оставляет прежний файл валидным, если запись прервалась', async () => {
    const cache = new ForecastCache({ directory });
    await cache.write(forecast);
    const before = await readFile(cache.path, 'utf8');

    // Имитация прерывания: временный файл остаётся, переименования не было.
    await writeFile(`${cache.path}.123.456.tmp`, 'обрывок', 'utf8');

    expect(await readFile(cache.path, 'utf8')).toBe(before);
    await expect(cache.read()).resolves.toEqual(forecast);
  });

  it('перезаписывает прогноз новыми данными', async () => {
    const cache = new ForecastCache({ directory });
    await cache.write(forecast);
    await cache.write({ ...forecast, fetchedAt: '2026-10-31T11:00:00.000Z' });

    const read = await cache.read();
    expect(read?.fetchedAt).toBe('2026-10-31T11:00:00.000Z');
  });
});

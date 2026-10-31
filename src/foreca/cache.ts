/**
 * Кэш последнего успешного прогноза.
 *
 * Два свойства важнее остальных:
 *  1. запись атомарна — при падении посреди записи прежний файл остаётся целым;
 *  2. чтение не бросает — повреждённый кэш просто означает «данных нет».
 *
 * Кэш хранит не только данные, но и момент их получения: от этого зависит
 * признак устаревания на кадре.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ForecastStep, LocationInfo } from '../foreca/client.js';

export interface CachedForecast {
  /** Версия формата: старый кэш после изменения модели просто игнорируется. */
  readonly version: number;
  readonly fetchedAt: string;
  readonly location: LocationInfo;
  readonly steps: readonly ForecastStep[];
}

export const CACHE_VERSION = 1;

export interface ForecastCacheOptions {
  readonly directory: string;
  readonly fileName?: string;
}

const DEFAULT_FILE_NAME = 'forecast.json';

export class ForecastCache {
  readonly #path: string;

  constructor(options: ForecastCacheOptions) {
    this.#path = resolve(options.directory, options.fileName ?? DEFAULT_FILE_NAME);
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Читает кэш. Возвращает `undefined` при любой проблеме: нет файла,
   * битый JSON, чужая версия формата, отсутствие обязательных полей.
   */
  async read(): Promise<CachedForecast | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    return toCachedForecast(parsed);
  }

  /** Пишет кэш атомарно: сначала во временный файл, затем переименование. */
  async write(forecast: CachedForecast): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true });

    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(forecast, null, 2)}\n`, 'utf8');
    // rename в пределах одной файловой системы атомарен: читатель видит либо
    // старый файл целиком, либо новый целиком.
    await rename(temporary, this.#path);
  }
}

export function toCachedForecast(value: unknown): CachedForecast | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  if (record['version'] !== CACHE_VERSION) return undefined;
  if (typeof record['fetchedAt'] !== 'string') return undefined;
  if (Number.isNaN(Date.parse(record['fetchedAt']))) return undefined;
  if (!Array.isArray(record['steps'])) return undefined;

  const location = toCachedLocation(record['location']);
  if (location === undefined) return undefined;

  const steps: ForecastStep[] = [];
  for (const item of record['steps']) {
    const step = toCachedStep(item);
    if (step !== undefined) steps.push(step);
  }

  return {
    version: CACHE_VERSION,
    fetchedAt: record['fetchedAt'],
    location,
    steps,
  };
}

function toCachedLocation(value: unknown): LocationInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string') return undefined;

  return {
    id: typeof record['id'] === 'number' ? record['id'] : undefined,
    name,
    country: typeof record['country'] === 'string' ? record['country'] : undefined,
    timezone: typeof record['timezone'] === 'string' ? record['timezone'] : undefined,
    adminArea: typeof record['adminArea'] === 'string' ? record['adminArea'] : undefined,
    lon: typeof record['lon'] === 'number' ? record['lon'] : undefined,
    lat: typeof record['lat'] === 'number' ? record['lat'] : undefined,
  };
}

function toCachedStep(value: unknown): ForecastStep | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const time = record['time'];
  const temperature = record['temperature'];
  if (typeof time !== 'string' || typeof temperature !== 'number') return undefined;

  return {
    time,
    temperature,
    symbol: typeof record['symbol'] === 'string' ? record['symbol'] : undefined,
    precipAccum: typeof record['precipAccum'] === 'number' ? record['precipAccum'] : undefined,
    windDir: typeof record['windDir'] === 'number' ? record['windDir'] : undefined,
    windSpeed: typeof record['windSpeed'] === 'number' ? record['windSpeed'] : undefined,
    cloudiness: typeof record['cloudiness'] === 'number' ? record['cloudiness'] : undefined,
  };
}

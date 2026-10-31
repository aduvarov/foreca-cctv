/**
 * Публичная точка входа модуля Foreca.
 *
 * Здесь же собирается связка «клиент + ретраи»: остальному коду не нужно знать,
 * что внутри запрос повторяется, и не нужно повторять эту проводку в каждом месте.
 */
import type { ForecaClient, ThreeHourlyForecast } from './client.js';
import { defaultRetryPolicy, withRetry } from './retry.js';
import type { RetryPolicy } from './retry.js';

export { ForecaClient, fetchHttpClient, redactToken } from './client.js';
export type {
  ForecastStep,
  ForecaClientOptions,
  HttpClient,
  LocationInfo,
  ThreeHourlyForecast,
} from './client.js';
export { ForecaError, isForecaError, parseRetryAfter } from './errors.js';
export type { ForecaErrorKind } from './errors.js';
export { ForecastCache, CACHE_VERSION, toCachedForecast } from './cache.js';
export type { CachedForecast, ForecastCacheOptions } from './cache.js';
export { EmptyForecastError, ForecastScheduler, formatLocation } from './scheduler.js';
export type { RefreshDeps, RefreshResult, SchedulerOptions } from './scheduler.js';
export { computeDelay, withRetry, defaultRetryPolicy } from './retry.js';
export type { RetryPolicy, RetryResult } from './retry.js';

/** Запас по числу шагов: сутки вперёд сверх недели, чтобы обрезка не зависела от сетки. */
export const FORECAST_PERIODS = 64;

export interface FetchForecastOptions {
  readonly client: ForecaClient;
  readonly locationQuery: string;
  readonly timezone?: string | undefined;
  readonly periods?: number;
  readonly policy?: RetryPolicy;
}

export interface FetchForecastResult {
  readonly forecast: ThreeHourlyForecast;
  readonly attempts: number;
}

/** Запрашивает прогноз с повторами и сообщает, сколько попыток потребовалось. */
export async function fetchForecast(options: FetchForecastOptions): Promise<FetchForecastResult> {
  const policy = options.policy ?? defaultRetryPolicy;

  const result = await withRetry(
    async () =>
      options.client.getThreeHourlyForecast(options.locationQuery, {
        ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        periods: options.periods ?? FORECAST_PERIODS,
      }),
    policy,
  );

  return { forecast: result.value, attempts: result.attempts };
}

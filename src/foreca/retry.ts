/**
 * Повторные попытки при обращении к Foreca.
 *
 * Правила:
 *  - повторяем только `timeout`, `network` и `rate-limit`;
 *  - `rate-limit` уважает `Retry-After`, даже если он больше обычной задержки;
 *  - задержка растёт экспоненциально и ограничена сверху;
 *  - попытки ограничены, чтобы не залипать навсегда.
 *
 * Часы и таймер передаются снаружи: тесты не должны ждать реальное время.
 */
import { isForecaError } from './errors.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60_000,
  jitter: 0.2,
};

export interface RetryDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Задержка перед попыткой `attempt` (1 — первая повторная). */
export function computeDelay(policy: RetryPolicy, attempt: number, retryAfterMs?: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, capped), policy.maxDelayMs);
  }
  return capped;
}

/** Джиттер размазывает одновременные повторы нескольких экземпляров. */
export function applyJitter(delayMs: number, jitter: number, random: () => number): number {
  if (jitter <= 0) return delayMs;
  const spread = delayMs * jitter;
  const offset = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(delayMs + offset));
}

export interface RetryResult<T> {
  readonly value: T;
  readonly attempts: number;
}

/**
 * Выполняет операцию с повторами. Возвращает число сделанных попыток:
 * планировщику это нужно, чтобы понимать, насколько источник нестабилен.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = defaultRetryPolicy,
  deps: RetryDeps = {},
): Promise<RetryResult<T>> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      const isLast = attempt >= policy.maxAttempts;
      if (isLast || !isRetryable(error)) throw error;

      const retryAfterMs = isForecaError(error) ? error.retryAfterMs : undefined;
      const delay = applyJitter(computeDelay(policy, attempt, retryAfterMs), policy.jitter, random);
      await sleep(delay);
    }
  }
}

function isRetryable(error: unknown): boolean {
  return isForecaError(error) && error.retryable;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

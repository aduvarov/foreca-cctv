import { describe, expect, it } from 'vitest';

import { authError, networkError, rateLimitError, timeoutError } from '../src/foreca/errors.js';
import { applyJitter, computeDelay, defaultRetryPolicy, withRetry } from '../src/foreca/retry.js';
import type { RetryPolicy } from '../src/foreca/retry.js';

const policy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 800,
  jitter: 0,
};

describe('computeDelay', () => {
  it('растёт экспоненциально', () => {
    expect(computeDelay(policy, 1)).toBe(100);
    expect(computeDelay(policy, 2)).toBe(200);
    expect(computeDelay(policy, 3)).toBe(400);
  });

  it('не превышает предел', () => {
    expect(computeDelay(policy, 10)).toBe(800);
  });

  it('уважает Retry-After, если он больше обычной задержки', () => {
    expect(computeDelay(policy, 1, 600)).toBe(600);
  });

  it('не срезает задержку ниже экспоненциальной', () => {
    expect(computeDelay(policy, 3, 50)).toBe(400);
  });

  it('не превышает предел даже при большом Retry-After', () => {
    expect(computeDelay(policy, 1, 60_000)).toBe(800);
  });
});

describe('applyJitter', () => {
  it('не меняет задержку при нулевом джиттере', () => {
    expect(applyJitter(100, 0, () => 0.5)).toBe(100);
  });

  it('держит результат в пределах разброса', () => {
    const low = applyJitter(100, 0.2, () => 0);
    const high = applyJitter(100, 0.2, () => 1);
    expect(low).toBe(80);
    expect(high).toBe(120);
  });

  it('не уходит в отрицательные значения', () => {
    expect(applyJitter(10, 2, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  it('возвращает результат с первой попытки', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      policy,
      { sleep: async () => {} },
    );

    expect(result).toEqual({ value: 'ok', attempts: 1 });
    expect(calls).toBe(1);
  });

  it('повторяет сетевую ошибку и считает попытки', async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await withRetry(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw networkError(new Error('boom'));
        return attempt;
      },
      policy,
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toEqual({ value: 3, attempts: 3 });
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('не повторяет ошибку авторизации', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw authError(401);
        },
        policy,
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toBe(1);
  });

  it('останавливается после исчерпания попыток', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw timeoutError(10);
        },
        policy,
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toBe(policy.maxAttempts);
  });

  it('использует Retry-After при ограничении частоты', async () => {
    const delays: number[] = [];
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw rateLimitError(429, 500);
        return 'ok';
      },
      policy,
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(delays).toEqual([500]);
  });

  it('не повторяет неизвестные ошибки', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('что-то своё');
        },
        policy,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/своё/);
    expect(calls).toBe(1);
  });

  it('по умолчанию не делает больше четырёх попыток', () => {
    expect(defaultRetryPolicy.maxAttempts).toBe(4);
  });
});

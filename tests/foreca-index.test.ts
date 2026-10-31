import { describe, expect, it, vi } from 'vitest';

import { FORECAST_PERIODS, fetchForecast } from '../src/foreca/index.js';
import type { ForecaClient, ThreeHourlyForecast } from '../src/foreca/client.js';
import { networkError } from '../src/foreca/errors.js';

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

function fakeClient(behaviour: (call: number) => Promise<ThreeHourlyForecast>): {
  client: ForecaClient;
  calls: { query: string; timezone: string | undefined; periods: number | undefined }[];
} {
  const calls: { query: string; timezone: string | undefined; periods: number | undefined }[] = [];
  let counter = 0;

  const client = {
    async getThreeHourlyForecast(
      query: string,
      options: { timezone?: string; periods?: number } = {},
    ) {
      counter += 1;
      calls.push({ query, timezone: options.timezone, periods: options.periods });
      return behaviour(counter);
    },
  } as unknown as ForecaClient;

  return { client, calls };
}

describe('fetchForecast', () => {
  it('запрашивает прогноз с запасом по периодам и часовым поясом', async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(forecast));

    const result = await fetchForecast({
      client,
      locationQuery: '73.1094,49.8047',
      timezone: 'Asia/Almaty',
    });

    expect(result.attempts).toBe(1);
    expect(calls[0]).toEqual({
      query: '73.1094,49.8047',
      timezone: 'Asia/Almaty',
      periods: FORECAST_PERIODS,
    });
  });

  it('повторяет сетевую ошибку и сообщает число попыток', async () => {
    const { client } = fakeClient((call) => {
      if (call < 3) return Promise.reject(networkError(new Error('нет сети')));
      return Promise.resolve(forecast);
    });

    const result = await fetchForecast({
      client,
      locationQuery: '73.1094,49.8047',
      policy: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
    });

    expect(result.attempts).toBe(3);
    expect(result.forecast.steps).toHaveLength(1);
  });

  it('не повторяет ошибку авторизации', async () => {
    const getThreeHourlyForecast = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('401'), { kind: 'auth' }));
    const client = { getThreeHourlyForecast } as unknown as ForecaClient;

    await expect(fetchForecast({ client, locationQuery: '1,2' })).rejects.toBeDefined();
    expect(getThreeHourlyForecast).toHaveBeenCalledOnce();
  });
});

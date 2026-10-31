import { describe, expect, it, vi } from 'vitest';

import { ForecaClient, redactToken } from '../src/foreca/client.js';
import type { HttpClient } from '../src/foreca/client.js';
import { ForecaError } from '../src/foreca/errors.js';
import {
  threeHourlyResponse,
  locationResponse,
  locationSearchResponse,
} from './fixtures/foreca.js';

const TOKEN = 'secret-token-value-123456';

interface RecordingClient extends HttpClient {
  readonly calls: { url: string; init: RequestInit }[];
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function recordingHttp(response: Response): RecordingClient {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    async request(url, init) {
      calls.push({ url, init });
      return response;
    },
  };
}

describe('ForecaClient: запросы', () => {
  it('отправляет Bearer-токен и параметры прогноза', async () => {
    const http = recordingHttp(jsonResponse(threeHourlyResponse));
    const client = new ForecaClient({ token: TOKEN, http });

    await client.getThreeHourlyForecast('73.1094,49.8047', { timezone: 'Asia/Almaty' });

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call).toBeDefined();
    const url = new URL(call!.url);
    expect(url.pathname).toBe('/api/v1/forecast/3hourly/73.1094%2C49.8047');
    expect(url.searchParams.get('dataset')).toBe('full');
    expect(url.searchParams.get('lang')).toBe('ru');
    expect(url.searchParams.get('tz')).toBe('Asia/Almaty');
    const headers = call!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('передаёт запас по periods, если он запрошен', async () => {
    const http = recordingHttp(jsonResponse(threeHourlyResponse));
    const client = new ForecaClient({ token: TOKEN, http });

    await client.getThreeHourlyForecast('73.1094,49.8047', { periods: 64 });

    const url = new URL(http.calls[0]!.url);
    expect(url.searchParams.get('periods')).toBe('64');
  });

  it('возвращает шаги прогноза в доменном виде', async () => {
    const http = recordingHttp(jsonResponse(threeHourlyResponse));
    const client = new ForecaClient({ token: TOKEN, http });

    const forecast = await client.getThreeHourlyForecast('73.1094,49.8047');

    expect(forecast.steps).toHaveLength(64);
    expect(forecast.steps[0]?.temperature).toBeTypeOf('number');
  });

  it('доверяет пустому списку шагов на уровне транспорта', async () => {
    // Транспорт не решает, что «пусто» — это ошибка: это дело планировщика.
    const http = recordingHttp(jsonResponse({ forecast: [] }));
    const client = new ForecaClient({ token: TOKEN, http });

    const forecast = await client.getThreeHourlyForecast('73.1094,49.8047');

    expect(forecast.steps).toEqual([]);
  });

  it('получает метаданные локации и поиск', async () => {
    const http = recordingHttp(jsonResponse(locationResponse));
    const client = new ForecaClient({ token: TOKEN, http });

    const location = await client.getLocation('100184745');

    expect(location.name).toBe('Караганда');
    expect(location.timezone).toBe('Asia/Almaty');
    expect(location.lon).toBe(73.1094);
    expect(location.lat).toBe(49.8047);
  });

  it('ищет локации и отдаёт все варианты', async () => {
    const http = recordingHttp(jsonResponse(locationSearchResponse));
    const client = new ForecaClient({ token: TOKEN, http });

    const found = await client.searchLocations('Караганда');

    expect(found).toHaveLength(2);
    expect(found.map((item) => item.country)).toEqual(['Казахстан', 'Россия']);
    const url = new URL(http.calls[0]!.url);
    // Кириллица в пути должна попадать в URL в процентном кодировании.
    expect(decodeURIComponent(url.pathname)).toBe('/api/v1/location/search/Караганда');
  });

  it('убирает повторяющиеся результаты поиска', async () => {
    // Реальный случай: Foreca вернула две записи одной Караганды
    // с одинаковыми id и координатами.
    const duplicate = {
      locations: [locationSearchResponse['locations'], locationSearchResponse['locations']].flat(),
    };
    const http = recordingHttp(jsonResponse(duplicate));
    const client = new ForecaClient({ token: TOKEN, http });

    const found = await client.searchLocations('Караганда');

    expect(found).toHaveLength(2);
    expect(new Set(found.map((item) => item.id)).size).toBe(2);
  });

  it('возвращает пустой список, если поиск ничего не нашёл', async () => {
    const http = recordingHttp(jsonResponse({ locations: [] }));
    const client = new ForecaClient({ token: TOKEN, http });

    await expect(client.searchLocations('абракадабра')).resolves.toEqual([]);
  });
});

describe('ForecaClient: категории ошибок', () => {
  const cases: { status: number; kind: string }[] = [
    { status: 401, kind: 'auth' },
    { status: 403, kind: 'auth' },
    { status: 402, kind: 'quota' },
    { status: 500, kind: 'http' },
    { status: 404, kind: 'http' },
  ];

  for (const { status, kind } of cases) {
    it(`переводит HTTP ${status} в категорию ${kind}`, async () => {
      const http = recordingHttp(new Response('nope', { status }));
      const client = new ForecaClient({ token: TOKEN, http });

      await expect(client.getThreeHourlyForecast('1,2')).rejects.toMatchObject({ kind });
    });
  }

  it('читает Retry-After в секундах', async () => {
    const http = recordingHttp(
      new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const client = new ForecaClient({ token: TOKEN, http });

    await expect(client.getThreeHourlyForecast('1,2')).rejects.toMatchObject({
      kind: 'rate-limit',
      retryAfterMs: 120_000,
    });
  });

  it('помечает сетевой сбой как повторяемый', async () => {
    const http: HttpClient = {
      async request() {
        throw new TypeError('fetch failed');
      },
    };
    const client = new ForecaClient({ token: TOKEN, http });

    await expect(client.getThreeHourlyForecast('1,2')).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForecaError && error.kind === 'network' && error.retryable,
    );
  });

  it('помечает превышение таймаута как повторяемый', async () => {
    const http: HttpClient = {
      async request(_url, init) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    };
    const client = new ForecaClient({ token: TOKEN, http, timeoutMs: 5 });

    await expect(client.getThreeHourlyForecast('1,2')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('не повторяет ошибку авторизации', async () => {
    const http = recordingHttp(new Response('', { status: 401 }));
    const client = new ForecaClient({ token: TOKEN, http });

    const error = await client.getThreeHourlyForecast('1,2').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForecaError);
    expect((error as ForecaError).retryable).toBe(false);
  });

  it('сообщает о несоответствии схеме отдельной категорией', async () => {
    const http = recordingHttp(jsonResponse({ forecast: 'строка вместо массива' }));
    const client = new ForecaClient({ token: TOKEN, http });

    await expect(client.getThreeHourlyForecast('1,2')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('не допускает токен в текст ошибки', async () => {
    const http: HttpClient = {
      async request() {
        throw new Error(`провал на токене ${TOKEN}`);
      },
    };
    const client = new ForecaClient({ token: TOKEN, http });

    const error = await client.getThreeHourlyForecast('1,2').catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(TOKEN);
  });

  it('redactToken скрывает значение, но не короткие строки', () => {
    expect(redactToken(`токен ${TOKEN} неверен`, TOKEN)).toBe('токен *** неверен');
    expect(redactToken('abc', 'abc')).toBe('abc');
  });

  it('отказывается работать без токена', () => {
    expect(() => new ForecaClient({ token: '   ' })).toThrow(/Токен/);
  });

  it('отвергает токен с не-ASCII символами до запроса', () => {
    // Такой токен ломает HTTP-заголовок, и пользователь видит «сетевую ошибку»
    // вместо понятного «токен неверный».
    expect(() => new ForecaClient({ token: 'токен-по-русски' })).toThrow(/недопустимые символы/);
    expect(() => new ForecaClient({ token: 'abc def' })).toThrow(/недопустимые символы/);
  });

  it('принимает обычный ASCII-токен и обрезает пробелы по краям', () => {
    expect(() => new ForecaClient({ token: '  abcDEF123._-  ' })).not.toThrow();
  });

  it('обрезает завершающий слэш в базовом адресе', async () => {
    const http = recordingHttp(jsonResponse(threeHourlyResponse));
    const client = new ForecaClient({ token: TOKEN, http, baseUrl: 'https://example.test/' });

    await client.getThreeHourlyForecast('1,2');

    expect(http.calls[0]!.url.startsWith('https://example.test/api/')).toBe(true);
  });

  it('подставляет язык по умолчанию и позволяет переопределить', async () => {
    const http = recordingHttp(jsonResponse(threeHourlyResponse));
    const client = new ForecaClient({ token: TOKEN, http, defaultLanguage: 'en' });

    await client.getThreeHourlyForecast('1,2');

    const url = new URL(http.calls[0]!.url);
    expect(url.searchParams.get('lang')).toBe('en');
  });

  it('не вызывает сеть при отмене сигналом', async () => {
    const controller = new AbortController();
    controller.abort();
    const http: HttpClient = {
      request(_url, init) {
        return Promise.reject(
          init.signal?.aborted === true
            ? Object.assign(new Error('aborted'), { name: 'AbortError' })
            : new Response(''),
        );
      },
    };
    const spy = vi.spyOn(http, 'request');
    const client = new ForecaClient({ token: TOKEN, http });

    await expect(
      client.getThreeHourlyForecast('1,2', { signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(spy).toHaveBeenCalledOnce();
  });
});

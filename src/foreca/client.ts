/**
 * Транспорт и клиент Foreca.
 *
 * Клиент не знает про кэш, планировщик и рендер: его задача — сделать запрос,
 * разобрать ответ сгенерированной zod-схемой и вернуть доменно понятный результат
 * или типизированную ошибку. Токен никогда не попадает в сообщения об ошибках
 * и в журнал.
 */
import type { ZodType } from 'zod';

import {
  zGetApiV1Forecast3HourlyLocationResponse,
  zGetApiV1LocationLocationResponse,
  zGetApiV1LocationSearchQueryResponse,
} from '../generated/zod.gen.js';

import {
  cancelledError,
  isForecaError,
  networkError,
  parseRetryAfter,
  rateLimitError,
  schemaError,
  timeoutError,
  authError,
  httpError,
  quotaError,
} from './errors.js';

/** Минимальный контракт транспорта: позволяет подменить fetch в тестах. */
export interface HttpClient {
  request(input: string, init: RequestInit): Promise<Response>;
}

export const fetchHttpClient: HttpClient = {
  async request(input, init) {
    return globalThis.fetch(input, init);
  },
};

export interface ForecaClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly defaultLanguage?: string;
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

const DEFAULT_BASE_URL = 'https://weatherapi.foreca.net';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LANGUAGE = 'ru';

/**
 * Скрывает токен на случай, если он всё же оказался в тексте.
 * Используется только для сообщений, которые уходят наружу.
 */
export function redactToken(text: string, token: string): string {
  if (token.length < 8) return text;
  return text.split(token).join('***');
}

export class ForecaClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #language: string;
  readonly #http: HttpClient;
  readonly #now: () => Date;

  constructor(options: ForecaClientOptions) {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new Error('Токен Foreca не задан');
    }
    // Токен уходит в HTTP-заголовок. Не-ASCII символы там недопустимы:
    // fetch падает с «сетевой ошибкой», и пользователь ищет проблему не там.
    if (!/^[\x21-\x7E]+$/.test(token)) {
      throw new Error(
        'Токен Foreca содержит недопустимые символы: ожидаются только латиница, цифры и знаки без пробелов',
      );
    }
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#language = options.defaultLanguage ?? DEFAULT_LANGUAGE;
    this.#http = options.http ?? fetchHttpClient;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Запрос 3-часового прогноза.
   *
   * `periods` запрашивается с запасом: обрезка по времени делает доменный слой,
   * потому что сетка шагов не совпадает с «сейчас».
   */
  async getThreeHourlyForecast(
    location: string,
    options: RequestOptions & { readonly timezone?: string; readonly periods?: number } = {},
  ): Promise<ThreeHourlyForecast> {
    const query = new URLSearchParams({
      dataset: 'full',
      lang: this.#language,
    });
    if (options.timezone !== undefined) query.set('tz', options.timezone);
    if (options.periods !== undefined) query.set('periods', String(options.periods));

    const body = await this.#getJson(
      `/api/v1/forecast/3hourly/${encodeURIComponent(location)}?${query.toString()}`,
      zGetApiV1Forecast3HourlyLocationResponse,
      options.signal,
    );

    return { steps: (body.forecast ?? []).map(toForecastStep) };
  }

  /** Метаданные локации: отображаемое имя и часовой пояс. */
  async getLocation(location: string, options: RequestOptions = {}): Promise<LocationInfo> {
    const query = new URLSearchParams({ lang: this.#language });
    const body = await this.#getJson(
      `/api/v1/location/${encodeURIComponent(location)}?${query.toString()}`,
      zGetApiV1LocationLocationResponse,
      options.signal,
    );
    return toLocationInfo(body);
  }

  /** Поиск локации по названию: нужен мастеру настройки. */
  async searchLocations(query: string, options: RequestOptions = {}): Promise<LocationInfo[]> {
    const params = new URLSearchParams({ lang: this.#language });
    const body = await this.#getJson(
      `/api/v1/location/search/${encodeURIComponent(query)}?${params.toString()}`,
      zGetApiV1LocationSearchQueryResponse,
      options.signal,
    );
    return (body.locations ?? []).map(toLocationInfo).filter((item) => item.id !== undefined);
  }

  async #getJson<T>(path: string, schema: ZodType<T>, signal: AbortSignal | undefined): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

    let response: Response;
    try {
      response = await this.#http.request(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/json',
        },
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted === true) throw cancelledError(error);
      if (isAbortError(error)) throw timeoutError(this.#timeoutMs, error);
      if (isForecaError(error)) throw error;
      throw networkError(error);
    }

    if (!response.ok) {
      this.#throwForStatus(response);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted === true) throw cancelledError(error);
      throw isAbortError(error) ? timeoutError(this.#timeoutMs, error) : networkError(error);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const details =
        first === undefined
          ? 'неизвестное несоответствие'
          : `${first.path.join('.')}: ${first.message}`;
      throw schemaError(redactToken(details, this.#token));
    }
    return parsed.data;
  }

  #throwForStatus(response: Response): never {
    const { status } = response;
    if (status === 401 || status === 403) throw authError(status);
    if (status === 402) throw quotaError(status);
    if (status === 429) {
      throw rateLimitError(
        status,
        parseRetryAfter(response.headers.get('retry-after'), this.#now()),
      );
    }
    throw httpError(status, response.statusText);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Доменная форма метаданных локации: без `undefined`-полей, удобна для рендера. */
export interface LocationInfo {
  readonly id: number | undefined;
  readonly name: string;
  readonly country: string | undefined;
  readonly timezone: string | undefined;
  readonly adminArea: string | undefined;
  readonly lon: number | undefined;
  readonly lat: number | undefined;
}

/** Доменная форма прогноза: набор шагов, валидность разбирает следующий слой. */
export interface ThreeHourlyForecast {
  readonly steps: readonly ForecastStep[];
}

export interface ForecastStep {
  readonly time: string | undefined;
  readonly symbol: string | undefined;
  readonly temperature: number | undefined;
  readonly precipAccum: number | undefined;
  readonly windDir: number | undefined;
  readonly windSpeed: number | undefined;
  readonly cloudiness: number | undefined;
}

/**
 * Приводит метаданные локации к доменному виду.
 *
 * Поля приходят как `T | null | undefined`: спека Foreca не размечена
 * `required` и `nullable`, а API возвращает `null` в необязательных полях.
 * Наружу отдаём только `T | undefined`, чтобы остальной код не проверял null.
 */
function toLocationInfo(raw: {
  id?: number | null | undefined;
  name?: string | null | undefined;
  country?: string | null | undefined;
  timezone?: string | null | undefined;
  adminArea?: string | null | undefined;
  lon?: number | null | undefined;
  lat?: number | null | undefined;
}): LocationInfo {
  return {
    id: raw.id ?? undefined,
    name: raw.name ?? '',
    country: raw.country ?? undefined,
    timezone: raw.timezone ?? undefined,
    adminArea: raw.adminArea ?? undefined,
    lon: raw.lon ?? undefined,
    lat: raw.lat ?? undefined,
  };
}

/** Шаг прогноза: `null` из API превращается в `undefined`, как и у локации. */
function toForecastStep(raw: {
  time?: string | null | undefined;
  symbol?: string | null | undefined;
  temperature?: number | null | undefined;
  precipAccum?: number | null | undefined;
  windDir?: number | null | undefined;
  windSpeed?: number | null | undefined;
  cloudiness?: number | null | undefined;
}): ForecastStep {
  return {
    time: raw.time ?? undefined,
    symbol: raw.symbol ?? undefined,
    temperature: raw.temperature ?? undefined,
    precipAccum: raw.precipAccum ?? undefined,
    windDir: raw.windDir ?? undefined,
    windSpeed: raw.windSpeed ?? undefined,
    cloudiness: raw.cloudiness ?? undefined,
  };
}

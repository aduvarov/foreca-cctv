/**
 * Планировщик обновления прогноза.
 *
 * Задачи:
 *  - будить обновление по интервалу;
 *  - не запускать второе обновление, пока идёт первое (single-flight);
 *  - отдавать текущий прогноз без ожидания сети;
 *  - хранить последнюю ошибку для наблюдаемости.
 *
 * Никаких таймеров внутри логики: расписание передаётся снаружи, поэтому
 * тесты идут мгновенно и детерминированно.
 */
import type { ForecaClient, LocationInfo, ThreeHourlyForecast } from './client.js';
import { isForecaError } from './errors.js';
import type { CachedForecast, ForecastCache } from './cache.js';

export interface RefreshResult {
  readonly ok: boolean;
  readonly fetchedAt: Date | undefined;
  readonly location: LocationInfo;
  readonly forecast: ThreeHourlyForecast | undefined;
  readonly error: unknown;
  /** Сколько попыток сделал ретрай. */
  readonly attempts: number;
  readonly fromCache: boolean;
}

export interface RefreshDeps {
  readonly client: ForecaClient;
  readonly cache: ForecastCache;
  readonly location: LocationInfo;
  readonly now: () => Date;
  /** Один проход обновления с ретраями: вынесен, чтобы не тащить политику внутрь. */
  readonly fetchThreeHourly: (
    location: string,
    timezone: string | undefined,
  ) => Promise<{ forecast: ThreeHourlyForecast; attempts: number }>;
}

export interface SchedulerOptions {
  /** Интервал плановых обновлений. */
  readonly intervalMs: number;
  readonly onRefreshed?: (result: RefreshResult) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Хранит последний успешный прогноз и умеет обновлять его.
 *
 * Разделение на `refresh` и `start` намеренное: первый вызов можно сделать
 * синхронно при старте, второй — завести расписание.
 */
export class ForecastScheduler {
  readonly #deps: RefreshDeps;
  readonly #options: SchedulerOptions;

  #current: CachedForecast | undefined;
  #lastError: unknown;
  #inFlight: Promise<RefreshResult> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: RefreshDeps, options: SchedulerOptions) {
    this.#deps = deps;
    this.#options = options;
  }

  /** Текущий прогноз без обращения к сети. */
  get current(): CachedForecast | undefined {
    return this.#current;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  get isRefreshing(): boolean {
    return this.#inFlight !== undefined;
  }

  /**
   * Читает кэш с диска. Вызывается до первого запроса к Foreca,
   * чтобы сервис мог начать вещание без сети.
   */
  async loadCache(): Promise<void> {
    const cached = await this.#deps.cache.read();
    if (cached !== undefined) {
      this.#current = cached;
    }
  }

  /**
   * Одно обновление. Параллельный вызов не создаёт второй запрос:
   * возвращается уже идущая операция.
   */
  refresh(): Promise<RefreshResult> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }

    const promise = this.#doRefresh().finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = promise;
    return promise;
  }

  /** Запускает расписание. Повторный вызов безвреден. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.#options.onError?.(error);
      });
    }, this.#options.intervalMs);
    // Расписание не должно удерживать процесс живым при штатном завершении.
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Ждёт завершения идущего обновления.
   *
   * Нужен при остановке: иначе запись кэша может произойти уже после того,
   * как сервис закрыл файлы, а процесс завершится с «фоновой» записью на диске.
   */
  async drain(): Promise<void> {
    const inFlight = this.#inFlight;
    if (inFlight === undefined) return;
    // Ошибки обновления уже обработаны внутри refresh.
    await inFlight.catch(() => undefined);
  }

  async #doRefresh(): Promise<RefreshResult> {
    const { client, cache, location, fetchThreeHourly } = this.#deps;

    try {
      const metadata = await this.#resolveLocation(client, location);
      const forecast = await fetchThreeHourly(formatLocation(metadata), metadata.timezone);

      const fetchedAt = this.#deps.now();
      const cached: CachedForecast = {
        version: 1,
        fetchedAt: fetchedAt.toISOString(),
        location: metadata,
        steps: forecast.forecast.steps.map((step) => ({
          time: step.time,
          temperature: step.temperature,
          symbol: step.symbol,
          precipAccum: step.precipAccum,
          windDir: step.windDir,
          windSpeed: step.windSpeed,
          cloudiness: step.cloudiness,
        })),
      };

      // Полнота: ответ без шагов не считается успехом и не заменяет кэш.
      if (cached.steps.length === 0) {
        throw new EmptyForecastError();
      }

      this.#current = cached;
      this.#lastError = undefined;
      await cache.write(cached);

      const result: RefreshResult = {
        ok: true,
        fetchedAt,
        location: metadata,
        forecast: forecast.forecast,
        error: undefined,
        attempts: forecast.attempts,
        fromCache: false,
      };
      this.#options.onRefreshed?.(result);
      return result;
    } catch (error) {
      this.#lastError = error;
      const previous = this.#current;
      const result: RefreshResult = {
        ok: false,
        fetchedAt: previous === undefined ? undefined : new Date(previous.fetchedAt),
        location: previous?.location ?? location,
        forecast: undefined,
        error,
        attempts: 0,
        fromCache: previous !== undefined,
      };
      this.#options.onError?.(error);
      return result;
    }
  }

  async #resolveLocation(client: ForecaClient, fallback: LocationInfo): Promise<LocationInfo> {
    if (fallback.timezone !== undefined && fallback.name.length > 0) {
      // Имени и пояса достаточно для рендера: лишний запрос не нужен.
      return fallback;
    }
    try {
      return await client.getLocation(formatLocation(fallback));
    } catch (error) {
      // Метаданные — не критичный путь: прогноз может быть получен и с фолбэком.
      if (isForecaError(error) && error.kind === 'auth') throw error;
      return fallback;
    }
  }
}

export class EmptyForecastError extends Error {
  constructor() {
    super('Foreca вернула прогноз без единого шага');
    this.name = 'EmptyForecastError';
  }
}

/**
 * API принимает `"долгота,широта"` — порядок важен и неочевиден.
 * Идентификатор надёжнее названия: название может найтись в нескольких странах.
 */
export function formatLocation(location: LocationInfo): string {
  if (typeof location.lon === 'number' && typeof location.lat === 'number') {
    return `${location.lon},${location.lat}`;
  }
  if (typeof location.id === 'number') {
    return String(location.id);
  }
  return location.name;
}

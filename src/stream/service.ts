/**
 * Сборка сервиса целиком.
 *
 * Связывает конфигурацию, обновление прогноза, отрисовку, публикацию и
 * локальный HTTP-сервер состояния. Всё это — одна точка входа, чтобы
 * остальные модули не знали друг о друге.
 */
import type { ServiceConfig } from '../config/schema.js';
import type { ForecaClient } from '../foreca/client.js';
import { fetchForecast } from '../foreca/index.js';
import type { RetryPolicy } from '../foreca/retry.js';
import { ForecastCache } from '../foreca/cache.js';
import { ForecastScheduler } from '../foreca/scheduler.js';
import type { WeekChart } from '../domain/week-chart.js';
import { buildWeekChart } from '../domain/week-chart.js';
import type { Renderer } from '../render/index.js';
import { createRenderer } from '../render/index.js';
import { FramePublisher } from './publisher.js';
import type { FrameSource } from './publisher.js';
import { EncoderSupervisor } from './supervisor.js';
import { startHealthServer } from './health.js';
import type { HealthSnapshot } from './health.js';

export interface ServiceDeps {
  readonly config: ServiceConfig;
  readonly client: ForecaClient;
  readonly now?: () => Date;
  readonly logger?: Logger;
  readonly createRendererImpl?: (options: { width: number; height: number }) => Promise<Renderer>;
  readonly createSupervisorImpl?: (
    options: ConstructorParameters<typeof EncoderSupervisor>[0],
  ) => EncoderSupervisor;
  readonly startHealthServerImpl?: typeof startHealthServer;
  /** Политика повторов: в тестах и для медленных сетей её полезно менять. */
  readonly retryPolicy?: RetryPolicy;
  readonly renderer?: Renderer;
  readonly scheduler?: ForecastScheduler;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message) => {
    process.stdout.write(`${new Date().toISOString()} INFO ${message}\n`);
  },
  warn: (message) => {
    process.stdout.write(`${new Date().toISOString()} WARN ${message}\n`);
  },
  error: (message, error) => {
    const suffix = error === undefined ? '' : `: ${describe(error)}`;
    process.stderr.write(`${new Date().toISOString()} ERROR ${message}${suffix}\n`);
  },
};

export interface RunningService {
  readonly health: HealthSnapshot;
  stop(): Promise<void>;
  /** Ждёт остановки: удобно для точки входа. */
  readonly finished: Promise<void>;
}

/** Собирает и запускает сервис. Вызывающий управляет жизненным циклом. */
export async function startService(deps: ServiceDeps): Promise<RunningService> {
  const logger = deps.logger ?? consoleLogger;
  const now = deps.now ?? (() => new Date());
  const { config } = deps;

  const renderer =
    deps.renderer ??
    (await (deps.createRendererImpl ?? createRenderer)({
      width: config.stream.width,
      height: config.stream.height,
    }));
  const cache = new ForecastCache({ directory: config.state.cacheDir });

  const scheduler =
    deps.scheduler ??
    new ForecastScheduler(
      {
        client: deps.client,
        cache,
        location: {
          id: config.location.id,
          name: config.location.name,
          country: config.location.country,
          timezone: config.location.timezone,
          adminArea: undefined,
          lon: config.location.lon,
          lat: config.location.lat,
        },
        now,
        fetchThreeHourly: async (query, timezone) => {
          const result = await fetchForecast({
            client: deps.client,
            locationQuery: query,
            timezone,
            ...(deps.retryPolicy === undefined ? {} : { policy: deps.retryPolicy }),
          });
          return { forecast: result.forecast, attempts: result.attempts };
        },
      },
      {
        intervalMs: config.api.refreshMinutes * 60_000,
        onRefreshed: (result) => {
          logger.info(
            `прогноз обновлён: шагов ${String(result.forecast?.steps.length ?? 0)}, попыток ${String(result.attempts)}`,
          );
        },
        onError: (error) => {
          logger.warn(`обновление прогноза не удалось: ${describe(error)}`);
        },
      },
    );

  // Кэш читается до первого запроса: сервис должен начать вещание без сети.
  await scheduler.loadCache();
  if (scheduler.current !== undefined) {
    logger.info(`прогноз взят из кэша: ${scheduler.current.fetchedAt}`);
  }

  const supervisor = (deps.createSupervisorImpl ?? ((options) => new EncoderSupervisor(options)))({
    encoder: {
      rtspUrl: config.stream.rtspUrl,
      width: config.stream.width,
      height: config.stream.height,
      fps: config.stream.fps,
      bitrateKbps: config.stream.bitrateKbps,
    },
    onEvent: (event) => {
      switch (event.type) {
        case 'started':
          logger.info(`публикация запущена (pid ${String(event.pid ?? '?')})`);
          break;
        case 'exited':
          logger.warn(
            `публикация прервана (код ${String(event.code ?? 'сигнал')}), перезапусков ${String(event.restarts)}`,
          );
          break;
        case 'stderr':
          logger.warn(`ffmpeg: ${event.line}`);
          break;
        case 'stopped':
          logger.info('публикация остановлена');
          break;
        case 'gave-up':
          logger.error(`публикация сдалась после ${String(event.restarts)} перезапусков`);
          break;
        default:
          break;
      }
    },
  });

  /** Текущая модель строится на каждый кадр: подписи дней зависят от «сейчас». */
  const buildChart = (): WeekChart | undefined => {
    const current = scheduler.current;
    if (current === undefined) return undefined;
    return buildWeekChart({
      location: current.location,
      steps: current.steps,
      now: now(),
      updatedAt: new Date(current.fetchedAt),
      staleAfterMs: config.api.staleAfterMinutes * 60_000,
    });
  };

  const source: FrameSource = {
    next(): Uint8Array {
      const chart = buildChart();
      // Без данных поток не прекращается: показываем сообщение и атрибуцию.
      if (chart === undefined || chart.days.length === 0) {
        return renderer.emptyPixels();
      }
      return renderer.pixels(chart);
    },
  };

  const publisher = new FramePublisher({
    supervisor,
    source,
    fps: config.stream.fps,
    onTick: () => {
      // Публикация идёт: сбрасываем серию падений в супервизоре.
      supervisor.noteHealthy();
    },
  });

  supervisor.start();
  publisher.start();

  // Обновление прогноза в фоне: ошибки логируются, но поток не останавливают.
  void scheduler.refresh().catch((error: unknown) => {
    logger.error('стартовое обновление прогноза не удалось', error);
  });
  scheduler.start();

  const healthServer = await (deps.startHealthServerImpl ?? startHealthServer)({
    port: config.state.healthPort,
    host: config.state.healthHost,
    snapshot: () => snapshot(scheduler, supervisor, publisher, now, config),
    png: () => renderPng(renderer, scheduler, config, now),
  });
  logger.info(`состояние и снимок: ${healthServer.url}/health, ${healthServer.url}/snapshot.png`);

  let stopped: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    stopped = resolve;
  });

  let stopping: Promise<void> | undefined;

  return {
    get health() {
      return snapshot(scheduler, supervisor, publisher, now, config);
    },
    /** Идемпотентная остановка: повторный вызов ждёт ту же операцию. */
    stop(): Promise<void> {
      stopping ??= (async () => {
        logger.info('остановка сервиса');
        scheduler.stop();
        await publisher.stop();
        await supervisor.stop();
        // Ждём идущее обновление: иначе запись кэша случится после остановки.
        await scheduler.drain();
        await healthServer.close();
        stopped?.();
      })();
      return stopping;
    },
    finished,
  };
}

function snapshot(
  scheduler: ForecastScheduler,
  supervisor: EncoderSupervisor,
  publisher: FramePublisher,
  now: () => Date,
  config: ServiceConfig,
): HealthSnapshot {
  const state = supervisor.state;
  const current = scheduler.current;
  const ageMinutes =
    current === undefined
      ? undefined
      : Math.max(0, Math.round((now().getTime() - Date.parse(current.fetchedAt)) / 60_000));

  return {
    streaming: state.running,
    lastFrameAt: state.lastFrameAt?.toISOString(),
    restarts: state.restarts,
    stale: ageMinutes === undefined ? true : ageMinutes > config.api.staleAfterMinutes,
    dataAgeMinutes: ageMinutes,
    lastError: state.lastError ?? lastErrorText(scheduler),
    ticks: publisher.ticks,
    dropped: publisher.dropped,
  };
}

function lastErrorText(scheduler: ForecastScheduler): string | undefined {
  const error = scheduler.lastError;
  return error === undefined ? undefined : describe(error);
}

function renderPng(
  renderer: Renderer,
  scheduler: ForecastScheduler,
  config: ServiceConfig,
  now: () => Date,
): Uint8Array {
  const current = scheduler.current;
  if (current === undefined) {
    return renderer.renderEmptyFrame().encodeSync('png');
  }
  const chart = buildWeekChart({
    location: current.location,
    steps: current.steps,
    now: now(),
    updatedAt: new Date(current.fetchedAt),
    staleAfterMs: config.api.staleAfterMinutes * 60_000,
  });
  return renderer.renderFrame(chart).encodeSync('png');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { HealthSnapshot } from './health.js';

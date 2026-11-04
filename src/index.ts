/**
 * Точка входа сервиса.
 *
 * Пока это только определение конфигурации на старте: мастер, bootstrap из
 * окружения, проверка повреждённого файла. Запуск вещания добавится в
 * capability rtsp-stream.
 */
import { resolve } from 'node:path';

import { bootstrapConfig } from './config/bootstrap.js';
import { decideStartup, isInteractive, parseArgs, usage } from './config/cli.js';
import { loadConfig, resolveConfigPath, saveConfig } from './config/store.js';
import { createStreamIo, runWizard, WizardCancelledError } from './config/wizard.js';
import type { ServiceConfig } from './config/schema.js';
import { ForecaClient } from './foreca/client.js';
import { startService } from './stream/service.js';
import type { RunningService } from './stream/service.js';

export interface CliDependencies {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly interactive: boolean;
  readonly runService: (config: ServiceConfig, configPath: string) => Promise<void>;
  /** Мастер настройки: подменяется в тестах, чтобы не читать реальный stdin. */
  readonly runWizardImpl?: typeof runWizard;
  readonly bootstrapConfigImpl?: typeof bootstrapConfig;
}

/** Возвращает код выхода: 0 — успех, 1 — ошибка конфигурации. */
export async function main(deps: CliDependencies): Promise<number> {
  const { options, problems } = parseArgs(deps.argv, deps.env);
  const configPath = resolveConfigPath(options.configPath);

  if (problems.length > 0) {
    deps.stderr.write(`${problems.join('\n')}\n\n${usage()}`);
    return 1;
  }

  const loaded = await loadConfig(options.configPath);
  const hasNonInteractiveSource = options.token !== undefined && options.location !== undefined;

  const plan = decideStartup({
    options,
    interactive: deps.interactive,
    config: { kind: loaded.kind, path: configPath },
    hasNonInteractiveSource,
  });

  switch (plan.action) {
    case 'help':
      deps.stdout.write(usage());
      return 0;

    case 'fail':
      deps.stderr.write(`${plan.message}\n`);
      return 1;

    case 'run': {
      if (loaded.kind !== 'loaded') {
        deps.stderr.write('Внутренняя ошибка: конфигурация не загружена\n');
        return 1;
      }
      await deps.runService(loaded.config, loaded.path);
      return 0;
    }

    case 'wizard': {
      const io = createStreamIo(process.stdin, deps.stdout);
      const wizard = deps.runWizardImpl ?? runWizard;
      let result;
      try {
        result = await wizard({
          io,
          createClient: (token) => new ForecaClient({ token }),
          ...(loaded.kind === 'loaded' ? { previousLocation: loaded.config.location } : {}),
        });
      } catch (error) {
        if (error instanceof WizardCancelledError) {
          deps.stderr.write('Настройка прервана: ввод закрыт\n');
          return 1;
        }
        throw error;
      }

      if (!result.ok) {
        deps.stderr.write(
          result.reason === 'token'
            ? 'Настройка прервана: токен не подтверждён\n'
            : 'Настройка прервана: локация не выбрана\n',
        );
        return 1;
      }

      const saved = await saveConfig(options.configPath, result.config);
      deps.stdout.write(`Конфигурация сохранена: ${saved}\n`);
      // Первый запуск не должен заканчиваться сохранением файла: пользователь
      // ждёт вещания, а не инструкции запустить сервис ещё раз.
      deps.stdout.write('Запускаю сервис…\n');
      await deps.runService(result.config, saved);
      return 0;
    }

    case 'bootstrap': {
      if (options.token === undefined || options.location === undefined) {
        deps.stderr.write('Для неинтерактивного запуска нужны FORECA_TOKEN и FORECA_LOCATION\n');
        return 1;
      }

      const bootstrap = deps.bootstrapConfigImpl ?? bootstrapConfig;
      const result = await bootstrap({
        createClient: (token) => new ForecaClient({ token }),
        token: options.token,
        locationQuery: options.location,
      });

      if (!result.ok) {
        deps.stderr.write(`${result.message}\n`);
        return 1;
      }

      const saved = await saveConfig(options.configPath, result.config);
      deps.stdout.write(`Конфигурация создана: ${saved}\n`);
      // В неинтерактивном режиме после создания конфигурации сразу вещаем:
      // контейнер не должен завершаться сразу после записи файла.
      deps.stdout.write('Запускаю сервис…\n');
      await deps.runService(result.config, saved);
      return 0;
    }

    default: {
      const exhaustive: never = plan;
      throw new Error(`Неизвестный план запуска: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export { isInteractive };

/** Собирает боевой сервис из конфигурации. */
async function runProductionService(config: ServiceConfig): Promise<void> {
  const service = await startService({
    config,
    client: new ForecaClient({
      token: config.forecaToken,
      baseUrl: config.api.baseUrl,
      timeoutMs: config.api.timeoutMs,
    }),
  });

  installShutdownHandlers(service);
  await service.finished;
}

/** Остановка по сигналу: FFmpeg должен завершиться, а не остаться сиротой. */
function installShutdownHandlers(service: RunningService): void {
  const shutdown = createShutdown({
    stop: () => service.stop(),
    log: (message) => {
      process.stderr.write(`${message}\n`);
    },
    exit: (code) => {
      process.exit(code);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    },
  });

  process.once('SIGINT', () => {
    shutdown('получен SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('получен SIGTERM');
  });

  // Непойманная ошибка не должна молча убивать сервис: без этих обработчиков
  // Node завершается без остановки FFmpeg, а журнал не объясняет, что случилось.
  // После uncaughtException состояние процесса не определено, поэтому
  // корректно останавливаемся и отдаём ненулевой код внешнему супервизору.
  process.once('uncaughtException', (error) => {
    shutdown(`непойманная ошибка: ${describeError(error)}`, 1);
  });
  process.once('unhandledRejection', (reason) => {
    shutdown(`необработанный отказ: ${describeError(reason)}`, 1);
  });
}

export interface ShutdownOptions {
  readonly stop: () => Promise<void>;
  readonly log: (message: string) => void;
  readonly exit: (code: number) => void;
  /** Код выхода при штатном завершении: иначе `uncaughtException` даст 0. */
  readonly setExitCode: (code: number) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Предел ожидания остановки: дольше ждать внешнему супервизору вредно. */
  readonly timeoutMs?: number;
}

/**
 * Идемпотентная остановка. Вынесена из обработчиков сигналов, чтобы её
 * поведение проверялось тестом без SIGTERM и без реального выхода процесса.
 */
export function createShutdown(
  options: ShutdownOptions,
): (reason: string, exitCode?: number) => void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let stopping = false;

  return (reason, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    options.log(`${reason}, останавливаюсь`);
    // Код фиксируется сразу: при `uncaughtException` процесс завершится
    // естественным образом после остановки, и без этого он вышел бы с нулём,
    // а внешний супервизор не отличил бы сбой от штатной остановки.
    options.setExitCode(exitCode);

    // Аварийный выход: если остановка зависла, процесс всё равно должен умереть,
    // иначе внешний супервизор будет ждать и не перезапустит сервис.
    const emergency = options.setTimer(() => {
      options.log(
        `остановка не завершилась за ${String(timeoutMs / 1000)} с, выхожу принудительно`,
      );
      options.exit(exitCode === 0 ? 1 : exitCode);
    }, timeoutMs);

    options
      .stop()
      .then(() => {
        options.clearTimer(emergency);
      })
      .catch((error: unknown) => {
        options.clearTimer(emergency);
        options.log(`ошибка при остановке: ${describeError(error)}`);
      });
  };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? error.message : `${code}: ${error.message}`;
}

// Запуск как CLI: main вызывается только при прямом выполнении файла,
// чтобы импорт из тестов не стартовал сервис.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const code = await main({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    interactive: isInteractive(),
    runService: runProductionService,
  });
  // Аварийная остановка уже выставила ненулевой код: не перетираем его нулём
  // от `main`, иначе внешний супервизор не увидит сбой.
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.exitCode = code;
  }
}

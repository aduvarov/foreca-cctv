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
      let result;
      try {
        result = await runWizard({
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
      return 0;
    }

    case 'bootstrap': {
      if (options.token === undefined || options.location === undefined) {
        deps.stderr.write('Для неинтерактивного запуска нужны FORECA_TOKEN и FORECA_LOCATION\n');
        return 1;
      }

      const result = await bootstrapConfig({
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
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`получен ${signal}, останавливаюсь\n`);
    service.stop().catch((error: unknown) => {
      process.stderr.write(`ошибка при остановке: ${String(error)}\n`);
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
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
  process.exitCode = code;
}

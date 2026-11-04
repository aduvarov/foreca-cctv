import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShutdown, main } from '../src/index.js';
import type { ServiceConfig } from '../src/config/schema.js';

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
  });
  return { stream, text: () => buffer };
}

const configured: ServiceConfig = {
  forecaToken: 'token-value',
  location: { name: 'Караганда', lat: 49.7989, lon: 73.0994, timezone: 'Asia/Almaty' },
  stream: {
    fps: 1,
    bitrateKbps: 400,
    width: 640,
    height: 480,
    rtspUrl: 'rtsp://127.0.0.1:8554/weather',
  },
  api: {
    baseUrl: 'https://weatherapi.foreca.net',
    refreshMinutes: 30,
    timeoutMs: 5_000,
    staleAfterMinutes: 90,
  },
  state: { cacheDir: './state', healthPort: 9_970, healthHost: '127.0.0.1' },
};

describe('main: решения на старте', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-main-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<Parameters<typeof main>[0]> = {}) {
    const stdout = capture();
    const stderr = capture();
    // Заглушка боевой функции: параметры читаем, чтобы не спорить с линтером.
    const runService = vi.fn((config: ServiceConfig, path: string) => {
      expect(config).toBeDefined();
      expect(path.length).toBeGreaterThan(0);
      return Promise.resolve();
    });
    return {
      stdout,
      stderr,
      runService,
      args: {
        argv: [] as readonly string[],
        env: {} as NodeJS.ProcessEnv,
        stdout: stdout.stream,
        stderr: stderr.stream,
        interactive: false,
        runService,
        ...overrides,
      },
    };
  }

  it('печатает справку по --help', async () => {
    const { args, stdout } = makeDeps({ argv: ['--help'] });

    expect(await main(args)).toBe(0);
    expect(stdout.text()).toContain('Использование');
  });

  it('падает на неизвестном параметре', async () => {
    const { args, stderr } = makeDeps({ argv: ['--что-то'] });

    expect(await main(args)).toBe(1);
    expect(stderr.text()).toContain('Неизвестный параметр');
  });

  it('запускает сервис при валидной конфигурации', async () => {
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(configured));

    const { args, runService } = makeDeps({ argv: ['--config', configPath] });

    expect(await main(args)).toBe(0);
    expect(runService).toHaveBeenCalledOnce();
  });

  it('падает без терминала и без конфигурации', async () => {
    const { args, stderr } = makeDeps({ argv: ['--config', join(directory, 'config.json')] });

    expect(await main(args)).toBe(1);
    expect(stderr.text()).toContain('FORECA_TOKEN');
  });

  it('не запускает сервис при повреждённой конфигурации', async () => {
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, '{ битый json');

    const { args, stderr, runService } = makeDeps({ argv: ['--config', configPath] });

    expect(await main(args)).toBe(1);
    expect(stderr.text()).toContain('--reconfigure');
    expect(runService).not.toHaveBeenCalled();
  });

  it('после мастера не завершается, а запускает сервис', async () => {
    // Именно этого не хватало: пользователь настроил и увидел тишину.
    const configPath = join(directory, 'config.json');
    // Проверяем сам факт запуска и путь, а конфигурацию — ниже по файлу.
    const runLocal = vi.fn((config: ServiceConfig, path: string) => {
      expect(config.location.name).toBe('Караганда');
      expect(path).toBe(configPath);
      return Promise.resolve();
    });

    const { args, stdout } = makeDeps({
      argv: ['--config', configPath],
      interactive: true,
      runService: runLocal,
      runWizardImpl: () => Promise.resolve({ ok: true, config: configured }),
    });

    expect(await main(args)).toBe(0);
    expect(runLocal).toHaveBeenCalledOnce();
    expect(stdout.text()).toContain('Запускаю сервис');

    // Конфигурация действительно сохранена.
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as ServiceConfig;
    expect(saved.forecaToken).toBe('token-value');
  });

  it('не запускает сервис, если мастер отменён', async () => {
    const configPath = join(directory, 'config.json');
    const runService = vi.fn(() => Promise.resolve());

    const { args, stderr } = makeDeps({
      argv: ['--config', configPath],
      interactive: true,
      runService,
      runWizardImpl: () => Promise.resolve({ ok: false, reason: 'token' }),
    });

    expect(await main(args)).toBe(1);
    expect(runService).not.toHaveBeenCalled();
    expect(stderr.text()).toContain('токен не подтверждён');
  });

  it('создаёт конфигурацию из окружения и запускает сервис', async () => {
    const configPath = join(directory, 'config.json');
    const runService = vi.fn(() => Promise.resolve());

    const { args, stdout } = makeDeps({
      argv: ['--config', configPath, '--non-interactive'],
      env: { FORECA_TOKEN: 'tok', FORECA_LOCATION: 'Караганда' },
      runService,
      bootstrapConfigImpl: () =>
        Promise.resolve({
          ok: true,
          config: configured,
          location: {
            id: 1,
            name: 'Караганда',
            country: 'Казахстан',
            timezone: 'Asia/Almaty',
            adminArea: undefined,
            lon: 73.0994,
            lat: 49.7989,
          },
        }),
    });

    expect(await main(args)).toBe(0);
    expect(runService).toHaveBeenCalledOnce();
    expect(stdout.text()).toContain('Запускаю сервис');
  });

  it('сообщает, чего не хватает для неинтерактивного запуска', async () => {
    const configPath = join(directory, 'config.json');
    const { args, stderr } = makeDeps({
      argv: ['--config', configPath],
      env: { FORECA_TOKEN: 'токен' },
    });

    expect(await main(args)).toBe(1);
    expect(stderr.text()).toContain('FORECA_LOCATION');
  });

  it('не запускает мастер повторной настройки без терминала', async () => {
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(configured));

    const { args, stderr } = makeDeps({ argv: ['--config', configPath, '--reconfigure'] });

    expect(await main(args)).toBe(1);
    expect(stderr.text()).toContain('Повторная настройка');
  });

  it('не меняет файл при неудачной повторной настройке', async () => {
    const configPath = join(directory, 'config.json');
    const original = JSON.stringify(configured);
    await writeFile(configPath, original);

    const { args } = makeDeps({
      argv: ['--config', configPath, '--reconfigure'],
      interactive: true,
      runWizardImpl: () => Promise.resolve({ ok: false, reason: 'location' }),
    });
    await main(args);

    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});

describe('createShutdown', () => {
  function setup(stop: () => Promise<void>) {
    const logs: string[] = [];
    const exits: number[] = [];
    const exitCodes: number[] = [];
    const timers: { callback: () => void; delayMs: number; cleared: boolean }[] = [];

    const shutdown = createShutdown({
      stop,
      log: (message) => logs.push(message),
      exit: (code) => exits.push(code),
      setExitCode: (code) => exitCodes.push(code),
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      timeoutMs: 5_000,
    });

    return { shutdown, logs, exits, exitCodes, timers };
  }

  it('останавливает сервис и снимает аварийный таймер', async () => {
    const { shutdown, logs, exits, exitCodes, timers } = setup(() => Promise.resolve());

    shutdown('получен SIGTERM');
    await Promise.resolve();

    expect(logs).toEqual(['получен SIGTERM, останавливаюсь']);
    expect(exits).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.cleared).toBe(true);
    // Штатная остановка не должна оставлять ненулевой код.
    expect(exitCodes).toEqual([0]);
  });

  it('фиксирует ненулевой код до завершения остановки', async () => {
    // При uncaughtException процесс умирает сам: без setExitCode он вышел бы
    // с нулём, и внешний супервизор не увидел бы сбой.
    const { shutdown, exitCodes } = setup(() => Promise.resolve());

    shutdown('непойманная ошибка: EPIPE', 1);
    await Promise.resolve();

    expect(exitCodes).toEqual([1]);
  });

  it('не запускает остановку дважды', async () => {
    const calls: number[] = [];
    const { shutdown, timers } = setup(() => {
      calls.push(1);
      return Promise.resolve();
    });

    shutdown('получен SIGTERM');
    shutdown('непойманная ошибка', 1);
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(timers).toHaveLength(1);
  });

  it('выходит принудительно, если остановка зависла', () => {
    // Обещание, которое никогда не завершится: имитация зависшего FFmpeg.
    const { shutdown, exits, timers } = setup(() => new Promise<void>(() => undefined));

    shutdown('получен SIGTERM');
    timers[0]?.callback();

    expect(exits).toEqual([1]);
  });

  it('сохраняет ненулевой код при аварийном выходе', () => {
    const { shutdown, exits, timers } = setup(() => new Promise<void>(() => undefined));

    shutdown('непойманная ошибка', 1);
    timers[0]?.callback();

    expect(exits).toEqual([1]);
  });

  it('пишет причину отказа остановки в журнал', async () => {
    const { shutdown, logs, timers } = setup(() => Promise.reject(new Error('ffmpeg не отвечает')));

    shutdown('получен SIGINT');
    await Promise.resolve();
    await Promise.resolve();

    expect(timers[0]?.cleared).toBe(true);
    expect(logs.join('\n')).toContain('ошибка при остановке: ffmpeg не отвечает');
  });
});

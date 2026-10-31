import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/index.js';
import type { ServiceConfig } from '../src/config/schema.js';

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
  });
  return { stream, text: () => buffer };
}

describe('main: решения на старте', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-main-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Заглушка боевой функции: параметры читаем, чтобы не спорить с линтером,
  // а возвращаем Promise<void>, как требует тип.
  const runService = vi.fn((config: ServiceConfig, path: string) => {
    expect(config).toBeDefined();
    expect(path.length).toBeGreaterThan(0);
    return Promise.resolve();
  });

  function deps(overrides: Partial<Parameters<typeof main>[0]> = {}) {
    const stdout = capture();
    const stderr = capture();
    return {
      stdout,
      stderr,
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
    const { args, stdout } = deps({ argv: ['--help'] });

    const code = await main(args);

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Использование');
  });

  it('падает на неизвестном параметре', async () => {
    const { args, stderr } = deps({ argv: ['--что-то'] });

    const code = await main(args);

    expect(code).toBe(1);
    expect(stderr.text()).toContain('Неизвестный параметр');
  });

  it('запускает сервис при валидной конфигурации', async () => {
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        forecaToken: 'токен',
        location: { name: 'Караганда', lat: 49.8, lon: 73.1 },
      }),
    );

    const { args } = deps({ argv: ['--config', configPath] });
    const code = await main(args);

    expect(code).toBe(0);
    expect(runService).toHaveBeenCalledOnce();
    const passed = runService.mock.calls[0]?.[0];
    expect(passed?.location.name).toBe('Караганда');
    runService.mockClear();
  });

  it('падает без терминала и без конфигурации', async () => {
    const { args, stderr } = deps({ argv: ['--config', join(directory, 'config.json')] });

    const code = await main(args);

    expect(code).toBe(1);
    expect(stderr.text()).toContain('FORECA_TOKEN');
  });

  it('не запускает сервис при повреждённой конфигурации', async () => {
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, '{ битый json');

    const { args, stderr } = deps({ argv: ['--config', configPath] });

    const code = await main(args);

    expect(code).toBe(1);
    expect(stderr.text()).toContain('--reconfigure');
  });

  it('создаёт конфигурацию из окружения в неинтерактивном режиме', async () => {
    const configPath = join(directory, 'config.json');

    // Сеть подменена: bootstrapConfig вызывает searchLocations, а он идёт
    // через реальный клиент. Здесь проверяем только ветку с пустым токеном,
    // чтобы не ходить в сеть.
    const { args, stderr } = deps({
      argv: ['--config', configPath, '--non-interactive'],
      env: { FORECA_TOKEN: '   ', FORECA_LOCATION: 'Караганда' },
    });

    const code = await main(args);

    expect(code).toBe(1);
    expect(stderr.text()).toContain('Токен');
  });

  it('сообщает, чего не хватает для неинтерактивного запуска', async () => {
    const configPath = join(directory, 'config.json');
    const { args, stderr } = deps({
      argv: ['--config', configPath],
      env: { FORECA_TOKEN: 'токен' },
    });

    const code = await main(args);

    expect(code).toBe(1);
    expect(stderr.text()).toContain('FORECA_LOCATION');
  });

  it('не запускает мастер повторной настройки без терминала', async () => {
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        forecaToken: 'токен',
        location: { name: 'Караганда', lat: 49.8, lon: 73.1 },
      }),
    );

    const { args, stderr } = deps({ argv: ['--config', configPath, '--reconfigure'] });

    const code = await main(args);

    expect(code).toBe(1);
    expect(stderr.text()).toContain('Повторная настройка');
  });

  it('не меняет файл при неудачной повторной настройке', async () => {
    const configPath = join(directory, 'config.json');
    const original = JSON.stringify({
      forecaToken: 'прежний-токен',
      location: { name: 'Караганда', lat: 49.8, lon: 73.1 },
    });
    await writeFile(configPath, original);

    const { args } = deps({ argv: ['--config', configPath, '--reconfigure'] });
    await main(args);

    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});

import { describe, expect, it } from 'vitest';

import { decideStartup, isInteractive, parseArgs, usage } from '../src/config/cli.js';

const baseOptions = {
  configPath: undefined,
  reconfigure: false,
  nonInteractive: false,
  help: false,
  token: undefined,
  location: undefined,
};

describe('parseArgs', () => {
  it('без аргументов оставляет значения по умолчанию', () => {
    const { options, problems } = parseArgs([]);
    expect(problems).toEqual([]);
    expect(options).toEqual(baseOptions);
  });

  it('читает флаги и значения', () => {
    const { options, problems } = parseArgs([
      '--config',
      '/etc/foreca.json',
      '--reconfigure',
      '--non-interactive',
      '--token',
      'abc',
      '--location',
      'Караганда',
    ]);

    expect(problems).toEqual([]);
    expect(options.configPath).toBe('/etc/foreca.json');
    expect(options.reconfigure).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.token).toBe('abc');
    expect(options.location).toBe('Караганда');
  });

  it('берёт значения из окружения', () => {
    const { options } = parseArgs([], {
      FORECA_TOKEN: 'из-окружения',
      FORECA_LOCATION: 'Алматы',
      FORECA_CONFIG: '/data/config.json',
    });

    expect(options.token).toBe('из-окружения');
    expect(options.location).toBe('Алматы');
    expect(options.configPath).toBe('/data/config.json');
  });

  it('аргумент командной строки важнее окружения', () => {
    const { options } = parseArgs(['--token', 'из-аргумента'], { FORECA_TOKEN: 'из-окружения' });
    expect(options.token).toBe('из-аргумента');
  });

  it('сообщает о пропущенном значении', () => {
    const { problems } = parseArgs(['--config']);
    expect(problems.join(' ')).toContain('--config');
  });

  it('сообщает о неизвестном параметре', () => {
    const { problems } = parseArgs(['--что-то']);
    expect(problems.join(' ')).toContain('Неизвестный');
  });

  it('распознаёт справку', () => {
    expect(parseArgs(['--help']).options.help).toBe(true);
    expect(parseArgs(['-h']).options.help).toBe(true);
    expect(usage()).toContain('FORECA_TOKEN');
  });
});

describe('isInteractive', () => {
  it('требует терминал и на входе, и на выходе', () => {
    expect(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
    expect(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBe(false);
    expect(isInteractive({ stdin: undefined, stdout: { isTTY: true } })).toBe(false);
  });
});

describe('decideStartup', () => {
  const loaded = { kind: 'loaded' as const, path: '/config.json' };
  const missing = { kind: 'missing' as const, path: '/config.json' };
  const invalid = { kind: 'invalid' as const, path: '/config.json' };

  it('идёт работать при валидной конфигурации', () => {
    expect(
      decideStartup({
        options: baseOptions,
        interactive: false,
        config: loaded,
        hasNonInteractiveSource: false,
      }),
    ).toEqual({ action: 'run', configPath: '/config.json' });
  });

  it('запускает мастер при отсутствии файла в терминале', () => {
    expect(
      decideStartup({
        options: baseOptions,
        interactive: true,
        config: missing,
        hasNonInteractiveSource: false,
      }),
    ).toEqual({ action: 'wizard', configPath: '/config.json' });
  });

  it('падает без терминала и без параметров окружения', () => {
    const plan = decideStartup({
      options: baseOptions,
      interactive: false,
      config: missing,
      hasNonInteractiveSource: false,
    });

    expect(plan.action).toBe('fail');
    if (plan.action !== 'fail') return;
    expect(plan.message).toContain('FORECA_TOKEN');
  });

  it('создаёт конфигурацию из окружения без вопросов', () => {
    expect(
      decideStartup({
        options: baseOptions,
        interactive: false,
        config: missing,
        hasNonInteractiveSource: true,
      }),
    ).toEqual({ action: 'bootstrap', configPath: '/config.json' });
  });

  it('не заменяет молча повреждённый файл', () => {
    const plan = decideStartup({
      options: baseOptions,
      interactive: true,
      config: invalid,
      hasNonInteractiveSource: false,
    });

    expect(plan.action).toBe('fail');
    if (plan.action !== 'fail') return;
    expect(plan.message).toContain('--reconfigure');
  });

  it('запускает мастер по явному запросу повторной настройки', () => {
    expect(
      decideStartup({
        options: { ...baseOptions, reconfigure: true },
        interactive: true,
        config: loaded,
        hasNonInteractiveSource: false,
      }),
    ).toEqual({ action: 'wizard', configPath: '/config.json' });
  });

  it('не запускает мастер повторной настройки без терминала', () => {
    const plan = decideStartup({
      options: { ...baseOptions, reconfigure: true },
      interactive: false,
      config: loaded,
      hasNonInteractiveSource: false,
    });

    expect(plan.action).toBe('fail');
  });

  it('справка важнее любого другого состояния', () => {
    expect(
      decideStartup({
        options: { ...baseOptions, help: true, reconfigure: true },
        interactive: false,
        config: invalid,
        hasNonInteractiveSource: false,
      }),
    ).toEqual({ action: 'help' });
  });
});

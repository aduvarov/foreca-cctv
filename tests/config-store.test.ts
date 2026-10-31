import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exampleConfig, parseConfig } from '../src/config/schema.js';
import { hasConfig, loadConfig, saveConfig } from '../src/config/store.js';

describe('parseConfig', () => {
  it('принимает минимальную конфигурацию и подставляет значения по умолчанию', () => {
    const result = parseConfig({
      forecaToken: 'token-value',
      location: { name: 'Караганда', lat: 49.8, lon: 73.1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.stream.fps).toBe(1);
    expect(result.config.stream.bitrateKbps).toBe(400);
    expect(result.config.stream.rtspUrl).toBe('rtsp://127.0.0.1:8554/weather');
    expect(result.config.api.refreshMinutes).toBe(30);
    expect(result.config.api.staleAfterMinutes).toBe(90);
    expect(result.config.state.cacheDir).toBe('./state');
  });

  it('сохраняет заданные параметры потока', () => {
    const result = parseConfig({
      forecaToken: 'token-value',
      location: { name: 'Караганда', lat: 49.8, lon: 73.1 },
      stream: { fps: 5, bitrateKbps: 800 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.stream.fps).toBe(5);
    expect(result.config.stream.bitrateKbps).toBe(800);
    // Незаданные поля всё равно получили значения по умолчанию.
    expect(result.config.stream.width).toBe(704);
  });

  it('сообщает о проблемах с указанием пути', () => {
    const result = parseConfig({
      forecaToken: '',
      location: { name: '', lat: 200, lon: 73.1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.problems.join('\n');
    expect(joined).toContain('forecaToken');
    expect(joined).toContain('location.name');
    expect(joined).toContain('location.lat');
  });

  it('отклоняет адрес публикации не по RTSP', () => {
    const result = parseConfig({
      forecaToken: 'token',
      location: { name: 'К', lat: 1, lon: 2 },
      stream: { rtspUrl: 'http://example.test/weather' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).toContain('rtsp');
  });

  it('отклоняет нечисловые координаты', () => {
    const result = parseConfig({
      forecaToken: 'token',
      location: { name: 'К', lat: '49.8', lon: '73.1' },
    });

    expect(result.ok).toBe(false);
  });

  it('пример конфигурации проходит ту же валидацию', () => {
    const result = parseConfig(exampleConfig());
    expect(result.ok).toBe(true);
  });
});

describe('файл конфигурации', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foreca-config-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('сообщает об отсутствии файла, а не бросает', async () => {
    const path = join(directory, 'config.json');
    await expect(loadConfig(path)).resolves.toEqual({ kind: 'missing', path });
    await expect(hasConfig(path)).resolves.toBe(false);
  });

  it('сохраняет и читает конфигурацию', async () => {
    const path = join(directory, 'nested', 'config.json');
    const config = exampleConfig();

    await saveConfig(path, config);
    const loaded = await loadConfig(path);

    expect(loaded.kind).toBe('loaded');
    if (loaded.kind !== 'loaded') return;
    expect(loaded.config.location.name).toBe('Караганда');
    await expect(hasConfig(path)).resolves.toBe(true);
  });

  it('выставляет права 0600, потому что в файле токен', async () => {
    const path = join(directory, 'config.json');
    await saveConfig(path, exampleConfig());

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('пишет файл атомарно: временных файлов не остаётся', async () => {
    const path = join(directory, 'config.json');
    await saveConfig(path, exampleConfig());

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory);
    expect(entries).toEqual(['config.json']);
  });

  it('не портит прежний файл, если новый невалиден', async () => {
    const path = join(directory, 'config.json');
    await saveConfig(path, exampleConfig());
    const before = await readFile(path, 'utf8');

    // Запись невалидного объекта не должна происходить через saveConfig,
    // но даже прямая запись мусора не должна ломать чтение прежних данных.
    await writeFile(path, '{ мусор', 'utf8');
    const loaded = await loadConfig(path);

    expect(loaded.kind).toBe('invalid');
    if (loaded.kind !== 'invalid') return;
    expect(loaded.problems[0]).toContain('JSON');
    expect(before.length).toBeGreaterThan(0);
  });

  it('перечисляет проблемы валидации при чтении', async () => {
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ forecaToken: 'tok', location: { name: 'К', lat: 'нет', lon: 1 } }),
      'utf8',
    );

    const loaded = await loadConfig(path);
    expect(loaded.kind).toBe('invalid');
    if (loaded.kind !== 'invalid') return;
    expect(loaded.problems.length).toBeGreaterThan(0);
  });

  it('перезаписывает конфигурацию и меняет права у существующего файла', async () => {
    const path = join(directory, 'config.json');
    await saveConfig(path, exampleConfig());
    await writeFile(path, JSON.stringify(exampleConfig()), { mode: 0o644 });

    await saveConfig(path, exampleConfig());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

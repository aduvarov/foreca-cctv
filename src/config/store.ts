/**
 * Загрузка конфигурации с диска и её атомарная запись.
 *
 * Три требования, которые определили форму модуля:
 *  1. чтение не должно бросать при отсутствии файла — это штатный первый запуск;
 *  2. ошибка валидации должна быть понятной, а не «unexpected token»;
 *  3. запись атомарна и сразу с правами `0600`: в файле лежит токен.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseConfig } from './schema.js';
import type { ServiceConfig } from './schema.js';

export const DEFAULT_CONFIG_FILE = 'config.json';

export type ConfigLoadResult =
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'invalid'; readonly path: string; readonly problems: readonly string[] }
  | { readonly kind: 'loaded'; readonly path: string; readonly config: ServiceConfig };

export function resolveConfigPath(path: string | undefined): string {
  return resolve(path ?? DEFAULT_CONFIG_FILE);
}

/** Читает и валидирует конфигурацию. Не бросает на штатных ошибках. */
export async function loadConfig(path: string | undefined): Promise<ConfigLoadResult> {
  const resolved = resolveConfigPath(path);

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: 'missing', path: resolved };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      path: resolved,
      problems: [`Файл не является корректным JSON: ${describe(error)}`],
    };
  }

  const result = parseConfig(parsed);
  if (!result.ok) {
    return { kind: 'invalid', path: resolved, problems: result.problems };
  }
  return { kind: 'loaded', path: resolved, config: result.config };
}

/**
 * Записывает конфигурацию атомарно и с правами `0600`.
 *
 * Права выставляются на временный файл до переименования: иначе между записью
 * и `chmod` токен был бы читаем другими пользователями.
 */
export async function saveConfig(path: string | undefined, config: ServiceConfig): Promise<string> {
  const resolved = resolveConfigPath(path);
  const directory = dirname(resolved);
  await mkdir(directory, { recursive: true });

  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  // chmod на случай, если umask ослабил права при создании.
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, resolved);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return resolved;
}

export async function hasConfig(path: string | undefined): Promise<boolean> {
  try {
    await readFile(resolveConfigPath(path), { encoding: 'utf8', flag: constants.O_RDONLY });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Пути к ресурсам и регистрация шрифтов.
 *
 * Шрифты и логотип лежат в репозитории: в контейнере системных шрифтов может
 * не быть, а кириллица без них превращается в квадраты. Регистрация идемпотентна,
 * чтобы повторные вызовы в тестах не плодили алиасы.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { GlobalFonts } from '@napi-rs/canvas';

export interface AssetPaths {
  readonly fontRegular: string;
  readonly fontBold: string;
  readonly logo: string;
}

export const FONT_REGULAR = 'ForecaSans';
export const FONT_BOLD = 'ForecaSansBold';

/**
 * Корень ассетов. По умолчанию — `assets` рядом с проектом, но путь можно
 * переопределить: в собранном виде структура каталогов отличается.
 */
export function defaultAssetsDir(): string {
  const candidates = [
    resolve(import.meta.dirname, '..', '..', 'assets'),
    resolve(import.meta.dirname, '..', '..', '..', 'assets'),
    resolve(process.cwd(), 'assets'),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'fonts', 'NotoSans-Regular.ttf'))) {
      return candidate;
    }
  }
  return candidates[0] as string;
}

export function assetPaths(assetsDir: string = defaultAssetsDir()): AssetPaths {
  return {
    fontRegular: resolve(assetsDir, 'fonts', 'NotoSans-Regular.ttf'),
    fontBold: resolve(assetsDir, 'fonts', 'NotoSans-Bold.ttf'),
    logo: resolve(assetsDir, 'logo', 'foreca-wrc.png'),
  };
}

let registered = false;

/**
 * Регистрирует шрифты один раз. Бросает, если файла нет: тихо подменять шрифт
 * системным нельзя — кириллица на VGA превратится в нечитаемое.
 *
 * Про версию пакета: `@napi-rs/canvas` зафиксирован на 0.1.88. В 0.1.89
 * появилась утечка на отрисовке — примерно 8 КБ на кадр, которая не
 * освобождается и не лечится `clearAllCache()`. При 1 fps это около 700 МБ
 * в сутки, поэтому версия не обновляется без повторного замера.
 */
export function ensureFonts(assetsDir: string = defaultAssetsDir()): AssetPaths {
  const paths = assetPaths(assetsDir);
  if (registered) return paths;

  for (const path of [paths.fontRegular, paths.fontBold]) {
    if (!existsSync(path)) {
      throw new Error(`Шрифт не найден: ${path}`);
    }
  }

  if (!GlobalFonts.registerFromPath(paths.fontRegular, FONT_REGULAR)) {
    throw new Error(`Не удалось зарегистрировать шрифт: ${paths.fontRegular}`);
  }
  if (!GlobalFonts.registerFromPath(paths.fontBold, FONT_BOLD)) {
    throw new Error(`Не удалось зарегистрировать шрифт: ${paths.fontBold}`);
  }

  registered = true;
  return paths;
}

/** Для тестов: позволяет заново зарегистрировать шрифты после смены каталога. */
export function resetFontRegistryForTests(): void {
  registered = false;
}

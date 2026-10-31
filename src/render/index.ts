/**
 * Сборка кадра: canvas, шрифты, логотип, layout и рисование.
 *
 * Наружу отдаётся только `renderFrame` и `renderEmptyFrame`: остальному коду
 * не нужно знать про canvas, RGBA и регистрацию шрифтов.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image } from '@napi-rs/canvas';

import type { WeekChart } from '../domain/week-chart.js';
import { drawEmptyFrame, drawFrame } from './canvas.js';
import { ensureFonts } from './assets.js';
import { layoutChart } from './layout.js';
import { BASE_HEIGHT, BASE_WIDTH, createTheme } from './theme.js';
import type { Theme } from './theme.js';

export interface RendererOptions {
  /** Готовая тема: имеет приоритет над размерами. */
  readonly theme?: Theme;
  /** Размер кадра: тема строится из него масштабированием базового макета. */
  readonly width?: number;
  readonly height?: number;
  readonly assetsDir?: string;
}

export interface Renderer {
  readonly width: number;
  readonly height: number;
  renderFrame(chart: WeekChart): Canvas;
  renderEmptyFrame(message?: string): Canvas;
  /** RGBA-пиксели кадра: то, что уходит в FFmpeg. */
  pixels(chart: WeekChart): Uint8Array;
  /** RGBA-пиксели кадра «нет данных». */
  emptyPixels(message?: string): Uint8Array;
}

const EMPTY_MESSAGE = 'Нет данных о погоде';

export async function createRenderer(options: RendererOptions = {}): Promise<Renderer> {
  const activeTheme =
    options.theme ?? createTheme(options.width ?? BASE_WIDTH, options.height ?? BASE_HEIGHT);

  const paths = options.assetsDir === undefined ? ensureFonts() : ensureFonts(options.assetsDir);
  const logo = await loadForecaLogo(paths.logo);

  // Canvas переиспользуется: при 1 fps это дешевле и не даёт расти памяти.
  const canvas = createCanvas(activeTheme.width, activeTheme.height);
  const ctx = canvas.getContext('2d');

  const renderFrame = (chart: WeekChart): Canvas => {
    const layout = layoutChart(chart, activeTheme);
    drawFrame({ ctx, layout, logo });
    return canvas;
  };

  const renderEmptyFrame = (message: string = EMPTY_MESSAGE): Canvas => {
    drawEmptyFrame(ctx, activeTheme, logo, message);
    return canvas;
  };

  return {
    width: activeTheme.width,
    height: activeTheme.height,
    renderFrame,
    renderEmptyFrame,
    pixels(chart) {
      renderFrame(chart);
      return toRgba(canvas);
    },
    emptyPixels(message) {
      return toRgba(renderEmptyFrame(message));
    },
  };
}

/**
 * Загружает логотип. Отсутствие файла — ошибка: кадр без атрибуции
 * нарушает условия использования API.
 */
async function loadForecaLogo(path: string): Promise<Image> {
  try {
    return await loadImage(path);
  } catch (error) {
    throw new Error(`Не удалось загрузить логотип Foreca (${path}): ${describe(error)}`, {
      cause: error,
    });
  }
}

/**
 * Возвращает RGBA-представление кадра.
 *
 * `canvas.data()` в ветке 0.1.x отдаёт `Buffer` без утечки; в 1.x этот вызов
 * течёт, поэтому версия зафиксирована. Копия нужна, потому что буфер может быть
 * переиспользован canvas при следующей отрисовке.
 */
export function toRgba(canvas: Canvas): Uint8Array {
  const data = canvas.data();
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { theme, createTheme, BASE_WIDTH, BASE_HEIGHT } from './theme.js';
export type { Theme } from './theme.js';

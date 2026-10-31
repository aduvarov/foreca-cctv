import { describe, expect, it } from 'vitest';

import { loadImage } from '@napi-rs/canvas';

import { buildWeekChart } from '../src/domain/week-chart.js';
import { assetPaths, defaultAssetsDir, ensureFonts } from '../src/render/assets.js';
import { drawEmptyFrame } from '../src/render/canvas.js';
import { createRenderer, toRgba } from '../src/render/index.js';
import { theme } from '../src/render/theme.js';
import { createTestChart } from './fixtures/chart.js';

const assets = assetPaths();

describe('ассеты рендера', () => {
  it('шрифты и логотип находятся', () => {
    const paths = ensureFonts();
    expect(paths.fontRegular).toContain('NotoSans-Regular.ttf');
    expect(paths.fontBold).toContain('NotoSans-Bold.ttf');
    expect(paths.logo).toContain('foreca-wrc.png');
  });

  it('каталог ассетов определяется и содержит шрифты', () => {
    const dir = defaultAssetsDir();
    expect(dir).toContain('assets');
    expect(assets.fontRegular.startsWith(dir)).toBe(true);
  });
});

describe('createRenderer', () => {
  it('кадр имеет базовый размер 704x576', async () => {
    const renderer = await createRenderer();
    const canvas = renderer.renderFrame(createTestChart());

    expect(canvas.width).toBe(704);
    expect(canvas.height).toBe(576);
  });

  it('строит кадр запрошенного размера', async () => {
    const renderer = await createRenderer({ width: 640, height: 480 });
    const canvas = renderer.renderFrame(createTestChart());

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
  });

  it('отдаёт RGBA на 704x576x4 байта', async () => {
    const renderer = await createRenderer();
    const pixels = renderer.pixels(createTestChart());

    expect(pixels.length).toBe(704 * 576 * 4);
  });

  it('кадр не пустой: на нём есть фон и элементы', async () => {
    const renderer = await createRenderer();
    const pixels = renderer.pixels(createTestChart());

    // Верхний левый угол — фон, значит он не чисто чёрный и не прозрачный.
    expect(pixels[0]).toBeGreaterThan(0);
    expect(pixels[3]).toBe(255);

    // Проверяем, что в кадре встречается много разных цветов: значит что-то нарисовано.
    const unique = new Set<number>();
    for (let index = 0; index < pixels.length; index += 4 * 997) {
      const value = pixels[index];
      if (value !== undefined) unique.add(value);
    }
    expect(unique.size).toBeGreaterThan(8);
  });

  it('рисует логотип в правом нижнем углу', async () => {
    const renderer = await createRenderer();
    const canvas = renderer.renderFrame(createTestChart());

    // Область логотипа: справа снизу. Ищем светлые пиксели.
    const ctx = canvas.getContext('2d');
    const logoWidth = Math.round((theme.logo.height * 500) / 111);
    const x = theme.width - theme.padding - logoWidth;
    const y = theme.height - theme.padding - theme.logo.height;
    const image = ctx.getImageData(x, y, logoWidth, theme.logo.height).data;

    let bright = 0;
    for (let index = 0; index < image.length; index += 4) {
      const r = image[index] ?? 0;
      const g = image[index + 1] ?? 0;
      const b = image[index + 2] ?? 0;
      if (r + g + b > 200) bright += 1;
    }
    expect(bright).toBeGreaterThan(100);
  });

  it('рисует бейдж устаревания только при устаревших данных', async () => {
    const renderer = await createRenderer();

    const fresh = createTestChart();
    const stale = createTestChart({ updatedAt: new Date('2026-10-31T05:00:00Z') });

    const freshPixels = renderer.pixels(fresh);
    const stalePixels = renderer.pixels(stale);

    expect(diffCount(freshPixels, stalePixels)).toBeGreaterThan(500);
  });

  it('строит кадр без данных', async () => {
    const renderer = await createRenderer();
    const canvas = renderer.renderEmptyFrame();
    const pixels = toRgba(canvas);

    expect(pixels.length).toBe(704 * 576 * 4);
    // Кадр не однотонный: на нём есть сообщение и логотип.
    const unique = new Set<number>();
    for (let index = 0; index < pixels.length; index += 4 * 997) {
      const value = pixels[index];
      if (value !== undefined) unique.add(value);
    }
    expect(unique.size).toBeGreaterThan(4);
  });

  it('укладывается в 50 мс на кадр', async () => {
    const renderer = await createRenderer();
    const chart = createTestChart();

    // Первый кадр разогревает шрифты и кэш Skia.
    renderer.renderFrame(chart);

    const started = process.hrtime.bigint();
    const frames = 20;
    for (let index = 0; index < frames; index += 1) {
      renderer.renderFrame(chart);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs / frames).toBeLessThan(50);
  });

  it('не накапливает память на тысячах кадров', async () => {
    const renderer = await createRenderer();
    const chart = createTestChart();

    // Прогрев, затем замер: утечка в ветке 1.x canvas проявлялась именно здесь.
    for (let index = 0; index < 50; index += 1) renderer.renderFrame(chart);
    if (globalThis.gc !== undefined) globalThis.gc();
    const before = process.memoryUsage().rss;

    for (let index = 0; index < 1500; index += 1) {
      renderer.renderFrame(chart);
    }
    if (globalThis.gc !== undefined) globalThis.gc();
    const after = process.memoryUsage().rss;

    const growthMb = (after - before) / 1024 / 1024;
    // 1500 кадров при утечке 1.x дали бы рост в гигабайты.
    expect(growthMb).toBeLessThan(120);
  });

  it('рисует кадр без данных с явным сообщением', async () => {
    const renderer = await createRenderer();
    const canvas = renderer.renderEmptyFrame('Нет данных о погоде');
    expect(canvas.width).toBe(704);
  });

  it('падает, если логотип не загружен: атрибуция обязательна', async () => {
    const renderer = await createRenderer();
    const canvas = renderer.renderFrame(createTestChart());
    const ctx = canvas.getContext('2d');

    expect(() => {
      drawEmptyFrame(ctx, theme, undefined, 'тест');
    }).toThrow(/атрибуция/);
  });

  it('логопит помещается с требуемым свободным полем', async () => {
    const logo = await loadImage(assets.logo);
    const height = theme.logo.height;
    const width = Math.round((height * logo.width) / logo.height);
    const x = theme.width - theme.padding - width;
    const y = theme.height - theme.padding - height;

    expect(x - theme.logo.minFreeSpace).toBeGreaterThanOrEqual(0);
    expect(y - theme.logo.minFreeSpace).toBeGreaterThanOrEqual(0);
  });
});

describe('модель без данных', () => {
  it('рендерится без исключений при пустой модели', async () => {
    const renderer = await createRenderer();
    const empty = buildWeekChart({
      location: {
        id: 1,
        name: 'Караганда',
        country: undefined,
        timezone: 'Asia/Almaty',
        adminArea: undefined,
        lon: 1,
        lat: 2,
      },
      steps: [],
      now: new Date('2026-10-31T10:40:00Z'),
      updatedAt: new Date('2026-10-31T10:40:00Z'),
    });

    expect(() => renderer.renderFrame(empty)).not.toThrow();
  });
});

function diffCount(left: Uint8Array, right: Uint8Array): number {
  let count = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) count += 1;
  }
  return count;
}

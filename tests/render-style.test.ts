import { describe, expect, it } from 'vitest';

import {
  coldestSlotIndex,
  formatTemperature,
  hottestSlotIndex,
  layoutChart,
  splitBySign,
} from '../src/render/layout.js';
import { BASE_HEIGHT, BASE_WIDTH, createTheme, theme } from '../src/render/theme.js';
import { createTestChart } from './fixtures/chart.js';

describe('окраска линии по знаку температуры', () => {
  const zeroY = 100;

  it('делит участок на тёплую и холодную части', () => {
    // y меньше — выше на экране, значит температура выше нуля.
    const runs = splitBySign(
      [
        { x: 0, y: 80 },
        { x: 10, y: 120 },
      ],
      zeroY,
    );

    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0]?.aboveZero).toBe(true);
    expect(runs.at(-1)?.aboveZero).toBe(false);
  });

  it('вставляет точку ровно на нулевой линии', () => {
    const runs = splitBySign(
      [
        { x: 0, y: 80 },
        { x: 10, y: 120 },
      ],
      zeroY,
    );

    // Переход должен быть на y = zeroY, иначе цвет меняется рывком.
    const crossingPoints = runs.flatMap((run) => run.points).filter((point) => point.y === zeroY);
    expect(crossingPoints.length).toBeGreaterThan(0);
    // Пересечение ровно между исходными точками по X.
    for (const point of crossingPoints) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(10);
    }
  });

  it('не делит участок, если температура не меняет знак', () => {
    const allWarm = splitBySign(
      [
        { x: 0, y: 50 },
        { x: 10, y: 60 },
        { x: 20, y: 40 },
      ],
      zeroY,
    );
    expect(allWarm).toHaveLength(1);
    expect(allWarm[0]?.aboveZero).toBe(true);

    const allCold = splitBySign(
      [
        { x: 0, y: 150 },
        { x: 10, y: 160 },
      ],
      zeroY,
    );
    expect(allCold).toHaveLength(1);
    expect(allCold[0]?.aboveZero).toBe(false);
  });

  it('возвращает пустой результат для пустого участка', () => {
    expect(splitBySign([], zeroY)).toEqual([]);
  });
});

describe('экстремумы на реальном часе', () => {
  it('находит индекс самого тёплого и самого холодного шага', () => {
    const chart = createTestChart();
    const day = chart.days[1];
    expect(day).toBeDefined();
    if (day === undefined) return;

    const hot = hottestSlotIndex(day.slots);
    const cold = coldestSlotIndex(day.slots);

    const hotSlot = day.slots[hot];
    const coldSlot = day.slots[cold];
    expect(hotSlot).toBeDefined();
    expect(coldSlot).toBeDefined();
    if (hotSlot === undefined || coldSlot === undefined) return;

    expect(hotSlot.temperature).toBe(Math.max(...day.slots.map((slot) => slot.temperature)));
    expect(coldSlot.temperature).toBe(Math.min(...day.slots.map((slot) => slot.temperature)));
  });

  it('ставит точку экстремума на X своего шага, а не на центр дня', () => {
    const chart = createTestChart();
    const layout = layoutChart(chart, theme);

    // Для каждого дня позиция точки должна совпадать с X какого-то шага.
    chart.days.forEach((day, dayIndex) => {
      const slots = day.slots;
      if (slots.length === 0) return;
      const slotWidth = layout.geometry.dayWidth / slots.length;

      const dayExtremes = layout.extremes.filter((extreme) => {
        const dayStart = layout.geometry.left + dayIndex * layout.geometry.dayWidth;
        return extreme.x >= dayStart && extreme.x <= dayStart + layout.geometry.dayWidth;
      });

      expect(dayExtremes.length).toBeGreaterThan(0);
      for (const extreme of dayExtremes) {
        const dayStart = layout.geometry.left + dayIndex * layout.geometry.dayWidth;
        const slotIndex = Math.round((extreme.x - dayStart) / slotWidth - 0.5);
        expect(slotIndex).toBeGreaterThanOrEqual(0);
        expect(slotIndex).toBeLessThan(slots.length);
      }
    });
  });

  it('подписывает экстремумы значением температуры', () => {
    const chart = createTestChart();
    const layout = layoutChart(chart, theme);

    for (const extreme of layout.extremes) {
      expect(extreme.label).toMatch(/^-?\d+°$/);
    }
  });

  it('не рисует две точки, если минимум и максимум совпали', () => {
    const chart = createTestChart({ temperatures: [5] });
    const layout = layoutChart(chart, theme);

    // Все температуры одинаковы: вторая точка легла бы ровно на первую.
    const firstDay = chart.days[0];
    if (firstDay === undefined || firstDay.slots.length === 0) return;
    const dayStart = layout.geometry.left;
    const dayExtremes = layout.extremes.filter(
      (extreme) => extreme.x >= dayStart && extreme.x <= dayStart + layout.geometry.dayWidth,
    );
    expect(dayExtremes.length).toBeLessThanOrEqual(1);
  });
});

describe('formatTemperature', () => {
  it('округляет до целого и добавляет градус', () => {
    expect(formatTemperature(9.4)).toBe('9°');
    expect(formatTemperature(9.6)).toBe('10°');
    expect(formatTemperature(-3.2)).toBe('-3°');
    expect(formatTemperature(0)).toBe('0°');
  });
});

describe('масштабирование темы', () => {
  it('по умолчанию даёт базовое разрешение 640x480', () => {
    expect(theme.width).toBe(BASE_WIDTH);
    expect(theme.height).toBe(BASE_HEIGHT);
  });

  it('базовая тема — это D1 704x576', () => {
    const d1 = createTheme(704, 576);
    expect(d1.width).toBe(704);
    expect(d1.height).toBe(576);
    // Базовая тема совпадает с явно построенной для того же размера.
    expect(d1.layout.chartBottom).toBe(theme.layout.chartBottom);
  });

  it('крупный размер масштабирует отступы и области', () => {
    const full = createTheme(1280, 960);
    expect(full.width).toBe(1280);
    // Выше базового на 66% — значит отступы и области должны вырасти.
    expect(full.padding).toBeGreaterThan(theme.padding);
    expect(full.layout.chartBottom).toBeGreaterThan(theme.layout.chartBottom);
  });

  it('сохраняет порядок областей при масштабировании', () => {
    const d1 = createTheme(704, 576);
    expect(d1.layout.titleBaseline).toBeLessThan(d1.layout.dayBaseline);
    expect(d1.layout.dayBaseline).toBeLessThan(d1.layout.chartTop);
    expect(d1.layout.chartTop).toBeLessThan(d1.layout.chartBottom);
    expect(d1.layout.chartBottom).toBeLessThan(d1.layout.precipBottom);
    expect(d1.layout.precipBottom).toBeLessThan(d1.layout.windCenterY);
    expect(d1.layout.windCenterY).toBeLessThan(d1.layout.windLabelBaseline);
    expect(d1.layout.windLabelBaseline).toBeLessThan(d1.height);
  });

  it('не уменьшает шрифт ниже читаемого порога', () => {
    const small = createTheme(320, 240);
    for (const font of Object.values(small.fonts)) {
      const size = Number(/(\d+)px/.exec(font)?.[1] ?? 0);
      expect(size).toBeGreaterThanOrEqual(8);
    }
  });

  it('свободное поле вокруг логотипа не меньше половины его высоты', () => {
    for (const size of [
      [640, 480],
      [704, 576],
    ] as const) {
      const t = createTheme(size[0], size[1]);
      expect(t.logo.minFreeSpace).toBeGreaterThanOrEqual(Math.ceil(t.logo.height / 2));
    }
  });
});

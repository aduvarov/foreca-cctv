import { describe, expect, it } from 'vitest';

import { drawIcon, parseSymbol } from '../src/render/icons.js';
import { buildSegments, clampControl, traceSmoothLine } from '../src/render/curve.js';
import {
  dateLabel,
  displaySlots,
  layoutChart,
  updatedLabel,
  weekdayLabel,
} from '../src/render/layout.js';
import { theme } from '../src/render/theme.js';
import { createTestChart } from './fixtures/chart.js';

describe('parseSymbol', () => {
  it.each([
    ['d000', { isNight: false, cloudiness: 0, precipitation: 0, precipitationType: 0 }],
    ['n300', { isNight: true, cloudiness: 3, precipitation: 0, precipitationType: 0 }],
    ['d421', { isNight: false, cloudiness: 4, precipitation: 2, precipitationType: 1 }],
    ['D210', { isNight: false, cloudiness: 2, precipitation: 1, precipitationType: 0 }],
  ])('разбирает %s', (code, expected) => {
    expect(parseSymbol(code)).toEqual(expected);
  });

  it('возвращает undefined для отсутствующего кода', () => {
    expect(parseSymbol(undefined)).toBeUndefined();
  });

  it('возвращает undefined для нераспознанного кода', () => {
    expect(parseSymbol('xyz')).toBeUndefined();
    expect(parseSymbol('d42')).toBeUndefined();
    expect(parseSymbol('')).toBeUndefined();
  });

  it('трактует высокие облака и туман как облачность', () => {
    expect(parseSymbol('d500')?.cloudiness).toBe(4);
    expect(parseSymbol('d600')?.cloudiness).toBe(4);
  });
});

describe('drawIcon', () => {
  it('рисует все комбинации без исключений', () => {
    const ctx = createFakeContext();
    for (const code of ['d000', 'n000', 'd200', 'd300', 'd400', 'n300', 'd421', 'd422', 'd440']) {
      const parts = parseSymbol(code);
      expect(parts).toBeDefined();
      if (parts === undefined) continue;
      expect(() => {
        drawIcon(ctx, parts, { centerX: 20, centerY: 20, radius: 8, theme });
      }).not.toThrow();
    }
  });
});

describe('buildSegments', () => {
  it('разрывает линию на пропуске', () => {
    const segments = buildSegments([{ x: 0, y: 0 }, { x: 1, y: 1 }, null, { x: 3, y: 3 }]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.points).toHaveLength(2);
    expect(segments[1]?.points).toHaveLength(1);
  });

  it('не отдаёт пустых сегментов', () => {
    expect(buildSegments([null, null])).toEqual([]);
  });
});

describe('clampControl', () => {
  it('не выпускает управляющую точку за пределы пары значений', () => {
    expect(clampControl(0, 100, 10, 20).y).toBe(20);
    expect(clampControl(0, -100, 10, 20).y).toBe(10);
  });

  it('оставляет точку внутри диапазона без изменений', () => {
    expect(clampControl(0, 15, 10, 20).y).toBe(15);
  });
});

describe('traceSmoothLine', () => {
  it('строит путь из одного сегмента', () => {
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push('begin'),
      moveTo: () => calls.push('moveTo'),
      bezierCurveTo: () => calls.push('bezier'),
    };

    traceSmoothLine(ctx, [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);

    expect(calls).toEqual(['begin', 'moveTo', 'bezier', 'bezier']);
  });

  it('не строит кривых для одной точки', () => {
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push('begin'),
      moveTo: () => calls.push('moveTo'),
      bezierCurveTo: () => calls.push('bezier'),
    };

    traceSmoothLine(ctx, [{ x: 0, y: 0 }]);

    expect(calls).toEqual(['begin', 'moveTo']);
  });
});

describe('layoutChart', () => {
  it('строит геометрию в границах кадра', () => {
    const chart = createTestChart();
    const layout = layoutChart(chart, theme);

    expect(layout.geometry.left).toBeGreaterThan(0);
    expect(layout.geometry.right).toBeLessThanOrEqual(theme.width);
    expect(layout.geometry.top).toBe(theme.layout.chartTop);
    expect(layout.geometry.bottom).toBe(theme.layout.chartBottom);
  });

  it('всегда включает ноль в шкалу', () => {
    const warm = layoutChart(createTestChart({ temperatures: [10, 20, 30] }), theme);
    expect(warm.geometry.scaleMin).toBeLessThanOrEqual(0);

    const cold = layoutChart(createTestChart({ temperatures: [-20, -10, -5] }), theme);
    expect(cold.geometry.scaleMax).toBeGreaterThanOrEqual(0);
  });

  it('нулевая линия попадает в область графика', () => {
    const layout = layoutChart(createTestChart(), theme);
    const zeroY = layout.geometry.yFor(0);
    expect(zeroY).toBeGreaterThanOrEqual(layout.geometry.top);
    expect(zeroY).toBeLessThanOrEqual(layout.geometry.bottom);
  });

  it('деления шкалы покрывают весь диапазон с шагом 5', () => {
    const layout = layoutChart(createTestChart(), theme);
    expect(layout.geometry.ticks[0]).toBe(layout.geometry.scaleMin);
    expect(layout.geometry.ticks.at(-1)).toBe(layout.geometry.scaleMax);
    for (let index = 1; index < layout.geometry.ticks.length; index += 1) {
      const previous = layout.geometry.ticks[index - 1];
      const current = layout.geometry.ticks[index];
      if (previous === undefined || current === undefined) continue;
      expect(current - previous).toBe(5);
    }
  });

  it('отмечает по две точки экстремумов на день с данными', () => {
    const chart = createTestChart();
    const layout = layoutChart(chart, theme);

    expect(layout.extremes).toHaveLength(chart.days.length * 2);
    expect(layout.extremes.filter((extreme) => extreme.kind === 'min')).toHaveLength(
      chart.days.length,
    );
  });

  it('строит столбики осадков по слотам', () => {
    const chart = createTestChart();
    const layout = layoutChart(chart, theme);
    const expected = chart.days.reduce((sum, day) => sum + day.precipitationSlots.length, 0);

    expect(layout.precipitation).toHaveLength(expected);
  });

  it('не выходит за пределы кадра по X', () => {
    const chart = createTestChart();
    const layout = layoutChart(chart, theme);

    for (const point of layout.series) {
      if (point === null) continue;
      expect(point.x).toBeGreaterThanOrEqual(layout.geometry.left);
      expect(point.x).toBeLessThanOrEqual(layout.geometry.right);
    }
  });

  it('рвёт линию на пропуске температуры', () => {
    const chart = createTestChart();
    // Убираем один слот из середины: точка исчезнет и линия разорвётся.
    const days = chart.days.map((day, index) =>
      index === 3
        ? { ...day, slots: day.slots.filter((_slot, slotIndex) => slotIndex !== 1) }
        : day,
    );
    const points = chart.points.filter((_point, index) => index !== 28);

    const layout = layoutChart({ ...chart, days, points }, theme);

    expect(layout.segments.length).toBeGreaterThan(1);
  });
});

describe('подписи', () => {
  it('weekdayLabel даёт русские сокращения', () => {
    expect(weekdayLabel(0)).toBe('пн');
    expect(weekdayLabel(5)).toBe('сб');
    expect(weekdayLabel(6)).toBe('вс');
    expect(weekdayLabel(99)).toBe('—');
  });

  it('dateLabel выводит ДД.ММ', () => {
    expect(dateLabel('2026-11-01')).toBe('01.11');
  });

  it('updatedLabel содержит время в поясе локации', () => {
    const chart = createTestChart();
    expect(updatedLabel(chart)).toMatch(/^обновлено \d{2}\.\d{2} \d{2}:\d{2}$/);
  });
});

describe('displaySlots', () => {
  it('выбирает четыре слота в полном дне', () => {
    const chart = createTestChart();
    const fullDay = chart.days[1];
    expect(fullDay).toBeDefined();
    if (fullDay === undefined) return;

    const slots = displaySlots(fullDay);
    expect(slots.map((slot) => slot.hour)).toEqual([3, 9, 15, 21]);
  });

  it('показывает все шаги, если предпочтительных часов нет', () => {
    const chart = createTestChart();
    const day = chart.days[0];
    expect(day).toBeDefined();
    if (day === undefined) return;

    const trimmed = { ...day, slots: day.slots.filter((slot) => slot.hour === 18) };
    expect(displaySlots(trimmed)).toHaveLength(1);
  });
});

/** Минимальный контекст для проверки, что рисование не бросает. */
function createFakeContext(): Parameters<typeof drawIcon>[0] {
  const noop = (): void => undefined;
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    moveTo: noop,
    lineTo: noop,
    fillText: noop,
    closePath: noop,
  } as unknown as Parameters<typeof drawIcon>[0];
}

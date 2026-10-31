/**
 * Отрисовка кадра недельного прогноза 640x480.
 *
 * Разделение ответственности:
 *  - `layout` считает геометрию и данные для примитивов, без рисования;
 *  - `chart` рисует по готовому layout.
 * Это позволяет тестировать раскладку (позиции, шкалы, попадание в границы)
 * без пиксельных сравнений, которые на шрифтах хрупки.
 */
import type { WeekChart } from '../domain/week-chart.js';
import { formatUpdatedAt } from '../domain/time.js';
import { buildSegments } from './curve.js';
import type { Point } from './curve.js';
import type { Theme } from './theme.js';

/**
 * Часы, на которые показывается иконка: четыре слота в сутки.
 * Полный день при 3-часовой сетке содержит 8 шагов, и рисовать все восемь
 * на 640 px бессмысленно — они физически не помещаются.
 */
export const DISPLAY_HOURS = [3, 9, 15, 21] as const;

/**
 * Выбирает шаги дня для показа.
 *
 * Обычный день даёт четыре слота (3, 9, 15, 21). Неполный первый день может
 * не содержать ни одного из этих часов — тогда показываются все его шаги,
 * иначе день остался бы без иконок.
 */
export function displaySlots(
  day: WeekChart['days'][number],
): readonly WeekChart['days'][number]['slots'][number][] {
  const preferred = day.slots.filter((slot) =>
    (DISPLAY_HOURS as readonly number[]).includes(slot.hour),
  );
  return preferred.length > 0 ? preferred : day.slots;
}

export interface ChartGeometry {
  readonly left: number;
  readonly right: number;
  readonly dayWidth: number;
  /** Положение центра дня по оси X. */
  readonly dayCenter: (dayIndex: number) => number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  /** Перевод температуры в Y. */
  readonly yFor: (temperature: number) => number;
  /** Границы области графика. */
  readonly top: number;
  readonly bottom: number;
  /** Деления шкалы. */
  readonly ticks: readonly number[];
}

export interface ChartLayout {
  readonly theme: Theme;
  readonly chart: WeekChart;
  readonly geometry: ChartGeometry;
  readonly series: readonly (Point | null)[];
  readonly segments: readonly { readonly points: readonly Point[] }[];
  /** Точки экстремумов по дням. */
  readonly extremes: readonly {
    readonly x: number;
    readonly y: number;
    readonly kind: 'min' | 'max';
  }[];
  /** Столбики осадков. */
  readonly precipitation: readonly {
    readonly x: number;
    readonly width: number;
    readonly height: number;
    readonly baseline: number;
    readonly value: number;
  }[];
  readonly daysWithoutData: number;
}

const AXIS_STEP = 5;

/**
 * Считает геометрию. Шкала всегда включает ноль и все температуры модели,
 * с округлением до шага деления — иначе нулевая линия окажется за кадром.
 */
export function layoutChart(chart: WeekChart, theme: Theme): ChartLayout {
  const { padding, layout } = theme;
  const left = padding + 15;
  const right = theme.width - padding;
  const dayWidth = (right - left) / Math.max(chart.days.length, 1);

  const temperatures = chart.points.map((point) => point.temperature);
  const minTemperature = temperatures.length > 0 ? Math.min(...temperatures) : -5;
  const maxTemperature = temperatures.length > 0 ? Math.max(...temperatures) : 5;

  const scaleMin = Math.floor((Math.min(minTemperature, 0) - 3) / AXIS_STEP) * AXIS_STEP;
  const scaleMax = Math.ceil((Math.max(maxTemperature, 0) + 3) / AXIS_STEP) * AXIS_STEP;
  const span = Math.max(scaleMax - scaleMin, AXIS_STEP);

  const top = layout.chartTop;
  const bottom = layout.chartBottom;
  const yFor = (temperature: number): number =>
    bottom - ((temperature - scaleMin) / span) * (bottom - top);

  const ticks: number[] = [];
  for (let value = scaleMin; value <= scaleMax; value += AXIS_STEP) {
    ticks.push(value);
  }

  const dayCenter = (dayIndex: number): number => left + dayIndex * dayWidth + dayWidth / 2;

  // Ряд точек по времени: X каждого шага пропорционален позиции внутри дня.
  const series: (Point | null)[] = [];
  const dayIndexByDate = new Map<string, number>();
  chart.days.forEach((day, index) => {
    dayIndexByDate.set(day.dateKey, index);
  });

  for (const point of chart.points) {
    const dateKey = pointDateKey(point, chart);
    const dayIndex = dayIndexByDate.get(dateKey);
    if (dayIndex === undefined) {
      series.push(null);
      continue;
    }

    const day = chart.days[dayIndex];
    if (day === undefined || day.slots.length === 0) {
      series.push(null);
      continue;
    }

    const slotIndex = day.slots.findIndex((slot) => slot.at.getTime() === point.at.getTime());
    if (slotIndex < 0) {
      series.push(null);
      continue;
    }

    const slotWidth = dayWidth / day.slots.length;
    const x = left + dayIndex * dayWidth + (slotIndex + 0.5) * slotWidth;
    series.push({ x, y: yFor(point.temperature) });
  }

  const segments = buildSegments(series);

  const extremes: { x: number; y: number; kind: 'min' | 'max' }[] = [];
  chart.days.forEach((day, index) => {
    if (day.minTemperature === undefined || day.maxTemperature === undefined) return;
    const x = dayCenter(index);
    extremes.push({ x, y: yFor(day.maxTemperature), kind: 'max' });
    extremes.push({ x, y: yFor(day.minTemperature), kind: 'min' });
  });

  // Осадки: один столбик на шестичасовой слот, общая шкала на весь кадр.
  const allMm = chart.days.flatMap((day) => day.precipitationSlots.map((slot) => slot.mm));
  const maxMm = Math.max(...allMm, 0.5);
  const precipHeight = layout.precipBottom - layout.precipTop;

  const precipitation: {
    x: number;
    width: number;
    height: number;
    baseline: number;
    value: number;
  }[] = [];

  chart.days.forEach((day, dayIndex) => {
    const slots = day.precipitationSlots;
    if (slots.length === 0) return;
    const slotWidth = dayWidth / slots.length;
    slots.forEach((slot, slotIndex) => {
      const height = (slot.mm / maxMm) * precipHeight;
      precipitation.push({
        x: left + dayIndex * dayWidth + slotIndex * slotWidth + slotWidth * 0.25,
        width: slotWidth * 0.5,
        height,
        baseline: layout.precipBottom,
        value: slot.mm,
      });
    });
  });

  return {
    theme,
    chart,
    geometry: { left, right, dayWidth, dayCenter, scaleMin, scaleMax, yFor, top, bottom, ticks },
    series,
    segments,
    extremes,
    precipitation,
    daysWithoutData: 0,
  };
}

/** Ключ даты для точки: считается по поясу локации, как и дни модели. */
function pointDateKey(point: WeekChart['points'][number], chart: WeekChart): string {
  const day = chart.days.find((candidate) =>
    candidate.slots.some((slot) => slot.at.getTime() === point.at.getTime()),
  );
  return day?.dateKey ?? '';
}

/** Форматирует время обновления так, как оно попадает на кадр. */
export function updatedLabel(chart: WeekChart): string {
  return `обновлено ${formatUpdatedAt(chart.updatedAt, chart.timeZone)}`;
}

/** Подпись дня: сокращённое имя по-русски. */
export const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_SHORT[weekday] ?? '—';
}

/** Дата в формате ДД.ММ для подписи под днём. */
export function dateLabel(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  if (month === undefined || day === undefined) return dateKey;
  return `${day}.${month}`;
}

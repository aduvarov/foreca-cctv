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
/**
 * Сколько иконок показывается в сутках.
 *
 * Ровно четыре: на 640 px больше не читается, а меньше — теряется динамика.
 */
export const ICONS_PER_DAY = 4;

/**
 * Выбирает шаги дня для показа иконок.
 *
 * Почему не по конкретным часам: сетка Foreca привязана к моменту запроса и
 * может быть 20/23/02/05, а не 03/09/15/21. Поиск по фиксированным часам
 * находил пустое множество, и тогда рисовались все восемь шагов — иконки
 * налезали друг на друга, а подписи сливались.
 *
 * Поэтому шаги делятся на четыре равные группы, и из каждой берётся один
 * представитель. Так работает при любой сетке.
 */
export function displaySlots(
  day: WeekChart['days'][number],
): readonly WeekChart['days'][number]['slots'][number][] {
  const { slots } = day;
  if (slots.length <= ICONS_PER_DAY) return slots;

  const result: WeekChart['days'][number]['slots'][number][] = [];
  for (let group = 0; group < ICONS_PER_DAY; group += 1) {
    const from = Math.floor((group * slots.length) / ICONS_PER_DAY);
    const to = Math.floor(((group + 1) * slots.length) / ICONS_PER_DAY);
    const middle = Math.floor((from + to - 1) / 2);
    const slot = slots[middle];
    if (slot !== undefined) result.push(slot);
  }
  return result;
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
  /** Точки экстремумов по дням: на реальном часе минимума и максимума. */
  readonly extremes: readonly {
    readonly x: number;
    readonly y: number;
    readonly kind: 'min' | 'max';
    readonly label: string;
  }[];
  /** Отрезки кривой, разделённые по знаку температуры для окраски. */
  readonly temperatureRuns: readonly {
    readonly points: readonly Point[];
    readonly aboveZero: boolean;
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

  // Кривая красится по знаку температуры: выше нуля — тёплый цвет, ниже —
  // холодный. Переход выполняется на самом пересечении нулевой линии, иначе
  // цвет менялся бы рывком между точками и это читалось бы как артефакт.
  const zeroY = yFor(0);
  const temperatureRuns = segments.flatMap((segment) => splitBySign(segment.points, zeroY));

  // Точки экстремумов ставятся на реальный час минимума и максимума, а не на
  // центр дня: иначе точка «висит» в стороне от вершины кривой и вводит в
  // заблуждение. Подпись — само значение температуры.
  const extremes: {
    x: number;
    y: number;
    kind: 'min' | 'max';
    label: string;
  }[] = [];

  chart.days.forEach((day, dayIndex) => {
    if (day.slots.length === 0) return;

    const slotWidth = dayWidth / day.slots.length;
    const xForSlot = (slotIndex: number): number =>
      left + dayIndex * dayWidth + (slotIndex + 0.5) * slotWidth;

    const hottest = hottestSlotIndex(day.slots);
    const coldest = coldestSlotIndex(day.slots);

    const hot = day.slots[hottest];
    if (hot !== undefined) {
      extremes.push({
        x: xForSlot(hottest),
        y: yFor(hot.temperature),
        kind: 'max',
        label: formatTemperature(hot.temperature),
      });
    }

    const cold = day.slots[coldest];
    // Если минимум и максимум попали в один шаг (ровная погода), вторая точка
    // не нужна: она легла бы ровно на первую.
    if (cold !== undefined && coldest !== hottest) {
      extremes.push({
        x: xForSlot(coldest),
        y: yFor(cold.temperature),
        kind: 'min',
        label: formatTemperature(cold.temperature),
      });
    }
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
    temperatureRuns,
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

/** Индекс самого тёплого шага дня. */
export function hottestSlotIndex(slots: WeekChart['days'][number]['slots']): number {
  let best = 0;
  for (let index = 1; index < slots.length; index += 1) {
    const slot = slots[index];
    const current = slots[best];
    if (slot === undefined || current === undefined) continue;
    if (slot.temperature > current.temperature) best = index;
  }
  return best;
}

/** Индекс самого холодного шага дня. */
export function coldestSlotIndex(slots: WeekChart['days'][number]['slots']): number {
  let best = 0;
  for (let index = 1; index < slots.length; index += 1) {
    const slot = slots[index];
    const current = slots[best];
    if (slot === undefined || current === undefined) continue;
    if (slot.temperature < current.temperature) best = index;
  }
  return best;
}

/** Подпись температуры на кадре: `8°`, `-3°`, без лишних дробей. */
export function formatTemperature(value: number): string {
  const rounded = Math.round(value);
  return `${rounded}°`;
}

/**
 * Делит непрерывный участок кривой на отрезки по знаку температуры.
 *
 * На пересечении нуля вставляется точка ровно на нулевой линии, поэтому
 * смена цвета происходит в месте перехода, а не между двумя точками данных.
 */
export function splitBySign(
  points: readonly Point[],
  zeroY: number,
): { points: readonly Point[]; aboveZero: boolean }[] {
  if (points.length === 0) return [];

  const runs: { points: Point[]; aboveZero: boolean }[] = [];
  let current: Point[] = [];
  let currentSign: boolean | undefined;

  for (const point of points) {
    // Меньше Y означает выше на экране, то есть температура выше нуля.
    const aboveZero = point.y < zeroY;
    // Точка ровно на нуле не определяет знак: она относится к текущему участку.
    const sign = point.y === zeroY ? currentSign : aboveZero;

    if (currentSign === undefined || sign === undefined || sign === currentSign) {
      current.push(point);
      if (sign !== undefined) currentSign = sign;
      continue;
    }

    // Переход знака: добавляем точку на нулевой линии в оба участка,
    // чтобы линия не рвалась визуально.
    const previous = current[current.length - 1];
    if (previous !== undefined) {
      const crossing = interpolateZero(previous, point, zeroY);
      current.push(crossing);
      runs.push({ points: current, aboveZero: currentSign });
      current = [crossing, point];
    } else {
      current = [point];
    }
    currentSign = sign;
  }

  if (current.length > 0 && currentSign !== undefined) {
    runs.push({ points: current, aboveZero: currentSign });
  }
  return runs;
}

function interpolateZero(from: Point, to: Point, zeroY: number): Point {
  const delta = to.y - from.y;
  if (delta === 0) return { x: to.x, y: zeroY };
  const ratio = (zeroY - from.y) / delta;
  return { x: from.x + (to.x - from.x) * ratio, y: zeroY };
}

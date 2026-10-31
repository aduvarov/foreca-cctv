/**
 * Доменная модель недельного прогноза.
 *
 * Ниже транспортного слоя всё считается готовым к отрисовке: дни уже сгруппированы
 * по поясу локации, осадки просуммированы за 6 часов, ветер повёрнут в сторону,
 * куда дует, а признаки свежести данных вынесены в отдельное поле.
 *
 * Границы семи суток считаются по времени, а не по индексу шага: сетка 3-часовых
 * шагов не совпадает с текущим моментом, и обрезка по индексу сдвинула бы день.
 */

import type { ForecastStep, LocationInfo } from '../foreca/client.js';
import { addDays, localDateKey, toLocalParts, weekdayIndex } from './time.js';

/** Сколько суток показывает кадр. */
export const DAYS_IN_VIEW = 7;

/** Шаг исходных данных в часах. */
export const STEP_HOURS = 3;

/** Период, за который суммируются осадки в одном столбике. */
export const PRECIP_WINDOW_HOURS = 6;

/** Шагов в сутках при 3-часовой сетке. */
const STEPS_PER_DAY = 24 / STEP_HOURS;

/** Часы, которые считаются ночными для выбора иконки. */
const NIGHT_FROM_HOUR = 19;
const NIGHT_UNTIL_HOUR = 7;

export interface ChartPoint {
  readonly at: Date;
  readonly temperature: number;
  /** 0 — понедельник. */
  readonly weekday: number;
}

export interface DaySlot {
  readonly hour: number;
  readonly at: Date;
  readonly temperature: number;
  readonly symbol: string | undefined;
  readonly isNight: boolean;
}

export interface PrecipSlot {
  readonly hour: number;
  readonly mm: number;
}

export interface WindView {
  /** Куда дует ветер, в градусах: значение API описывает, откуда дует. */
  readonly directionTo: number;
  readonly speedMs: number;
}

export interface DayView {
  readonly dateKey: string;
  /** 0 — понедельник. */
  readonly weekday: number;
  /** Первый день может быть неполным: он начинается с ближайшего шага. */
  readonly isPartial: boolean;
  readonly slots: readonly DaySlot[];
  readonly minTemperature: number | undefined;
  readonly maxTemperature: number | undefined;
  readonly precipitationMm: number;
  readonly precipitationSlots: readonly PrecipSlot[];
  readonly wind: WindView | undefined;
  /** Символ, представляющий день: самый «плохой» из дневных. */
  readonly symbol: string | undefined;
}

export interface WeekChart {
  readonly locationName: string;
  readonly timeZone: string;
  readonly days: readonly DayView[];
  readonly points: readonly ChartPoint[];
  /** Время последнего успешного обновления данных. */
  readonly updatedAt: Date;
  /** Признак устаревания: показывается на кадре. */
  readonly stale: boolean;
  /** Насколько прогноз отстал от текущего момента, в минутах. */
  readonly ageMinutes: number;
  /** Часовой пояс взят из данных API, а не из фолбэка. */
  readonly timeZoneResolved: boolean;
}

export interface BuildOptions {
  readonly location: LocationInfo;
  readonly steps: readonly ForecastStep[];
  readonly now: Date;
  readonly updatedAt: Date;
  /** Порог устаревания: если данные старше, кадр помечается. */
  readonly staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 90 * 60_000;

export interface NormalizedStep {
  readonly at: Date;
  readonly temperature: number;
  readonly symbol: string | undefined;
  readonly precipAccum: number;
  readonly windDir: number | undefined;
  readonly windSpeed: number | undefined;
}

/**
 * Приводит шаги к доменному виду и отбраковывает непригодные.
 *
 * Шаг без времени или без температуры не годится: по нему нельзя ни поставить
 * точку на кривой, ни определить сутки. Такие шаги не ломают весь ответ —
 * именно поэтому в спеке Foreca все поля необязательные, а полноту проверяем здесь.
 */
export function normalizeSteps(steps: readonly ForecastStep[], timeZone: string): NormalizedStep[] {
  const normalized: NormalizedStep[] = [];
  for (const step of steps) {
    if (step.time === undefined || step.temperature === undefined) continue;
    const at = new Date(step.time);
    if (Number.isNaN(at.getTime())) continue;
    if (!Number.isFinite(step.temperature)) continue;
    // Обращение к поясу здесь же валидирует его: неверный пояс бросит исключение.
    toLocalParts(at, timeZone);

    normalized.push({
      at,
      temperature: step.temperature,
      symbol: step.symbol,
      precipAccum: Number.isFinite(step.precipAccum) ? (step.precipAccum ?? 0) : 0,
      windDir: step.windDir,
      windSpeed: step.windSpeed,
    });
  }
  normalized.sort((left, right) => left.at.getTime() - right.at.getTime());
  return normalized;
}

/**
 * Обрезает шаги до окна отображения: от ближайшего шага вперёд на семь суток.
 *
 * Возвращает шаги, а не индексы: группировка по дням дальше опирается
 * на календарные даты локации.
 */
export function windowSteps(
  steps: readonly NormalizedStep[],
  now: Date,
  timeZone: string,
): NormalizedStep[] {
  const nowMs = now.getTime();

  // Ближайший шаг — первый, который не раньше текущего момента.
  // Если все шаги в прошлом, окно пустое: показывать нечего.
  const firstIndex = steps.findIndex((step) => step.at.getTime() >= nowMs);
  if (firstIndex < 0) return [];

  const first = steps[firstIndex];
  if (first === undefined) return [];

  const firstKey = localDateKey(first.at, timeZone);
  const lastAllowedKey = addDays(firstKey, DAYS_IN_VIEW - 1);

  return steps
    .slice(firstIndex)
    .filter((step) => localDateKey(step.at, timeZone) <= lastAllowedKey);
}

/** Группирует шаги по календарным датам пояса локации. */
export function groupByDate(
  steps: readonly NormalizedStep[],
  timeZone: string,
): Map<string, NormalizedStep[]> {
  const groups = new Map<string, NormalizedStep[]>();
  for (const step of steps) {
    const key = localDateKey(step.at, timeZone);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [step]);
    else bucket.push(step);
  }
  return groups;
}

/** Суммирует осадки парами 3-часовых шагов: столбик — шесть часов. */
export function sumPrecipitation(steps: readonly NormalizedStep[], timeZone: string): PrecipSlot[] {
  const slots: PrecipSlot[] = [];
  const pairSize = PRECIP_WINDOW_HOURS / STEP_HOURS;

  for (let index = 0; index < steps.length; index += pairSize) {
    const pair = steps.slice(index, index + pairSize);
    const anchor = pair[0];
    if (anchor === undefined) continue;
    const mm = pair.reduce((sum, step) => sum + step.precipAccum, 0);
    slots.push({ hour: toLocalParts(anchor.at, timeZone).hour, mm: roundMm(mm) });
  }
  return slots;
}

/** Направление стрелки и скорость: направление поворачивается на 180 градусов. */
export function toWindView(
  steps: readonly NormalizedStep[],
  timeZone: string,
): WindView | undefined {
  const candidates = steps.filter(
    (step): step is NormalizedStep & { windDir: number; windSpeed: number } =>
      step.windDir !== undefined &&
      step.windSpeed !== undefined &&
      Number.isFinite(step.windDir) &&
      Number.isFinite(step.windSpeed),
  );
  if (candidates.length === 0) return undefined;

  // Ближайший к полудню шаг лучше всего описывает день.
  const noon = candidates.reduce((best, step) => {
    const distance = Math.abs(toLocalParts(step.at, timeZone).hour - 12);
    const bestDistance = Math.abs(toLocalParts(best.at, timeZone).hour - 12);
    return distance < bestDistance ? step : best;
  });

  return {
    directionTo: (((noon.windDir + 180) % 360) + 360) % 360,
    speedMs: noon.windSpeed,
  };
}

export function buildWeekChart(options: BuildOptions): WeekChart {
  const { location, steps, now, updatedAt } = options;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const resolved = resolveTimeZone(location);
  const timeZone = resolved.timeZone;
  const normalized = normalizeSteps(steps, timeZone);
  const windowed = windowSteps(normalized, now, timeZone);
  const grouped = groupByDate(windowed, timeZone);

  const firstStep = windowed[0];
  const firstKey = firstStep === undefined ? undefined : localDateKey(firstStep.at, timeZone);

  const days: DayView[] = [];
  if (firstKey !== undefined) {
    for (let offset = 0; offset < DAYS_IN_VIEW; offset += 1) {
      const dateKey = addDays(firstKey, offset);
      const daySteps = grouped.get(dateKey);
      if (daySteps === undefined || daySteps.length === 0) continue;

      const temperatures = daySteps.map((step) => step.temperature);
      const slots: DaySlot[] = daySteps.map((step) => {
        const hour = toLocalParts(step.at, timeZone).hour;
        return {
          hour,
          at: step.at,
          temperature: step.temperature,
          symbol: step.symbol,
          isNight: isNightHour(hour),
        };
      });

      days.push({
        dateKey,
        weekday: weekdayIndex(dateKey),
        isPartial: offset === 0 && daySteps.length < STEPS_PER_DAY,
        slots,
        minTemperature: Math.min(...temperatures),
        maxTemperature: Math.max(...temperatures),
        precipitationMm: roundMm(daySteps.reduce((sum, step) => sum + step.precipAccum, 0)),
        precipitationSlots: sumPrecipitation(daySteps, timeZone),
        wind: toWindView(daySteps, timeZone),
        symbol: dominantSymbol(slots),
      });
    }
  }

  const points: ChartPoint[] = windowed.map((step) => ({
    at: step.at,
    temperature: step.temperature,
    weekday: weekdayIndex(localDateKey(step.at, timeZone)),
  }));

  const ageMs = Math.max(0, now.getTime() - updatedAt.getTime());

  return {
    locationName: location.name,
    timeZone,
    days,
    points,
    updatedAt,
    stale: ageMs > staleAfterMs,
    ageMinutes: Math.round(ageMs / 60_000),
    timeZoneResolved: resolved.resolved,
  };
}

function resolveTimeZone(location: LocationInfo): { timeZone: string; resolved: boolean } {
  if (location.timezone !== undefined && location.timezone.length > 0) {
    return { timeZone: location.timezone, resolved: true };
  }
  // Фолбэк на пояс хоста: подпись дня может съехать, поэтому признак сохраняется.
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, resolved: false };
}

function isNightHour(hour: number): boolean {
  return hour < NIGHT_UNTIL_HOUR || hour >= NIGHT_FROM_HOUR;
}

/**
 * Символ дня — самый «плохой» из дневных: осадки важнее облачности.
 * Если дневных шагов нет, берётся любой доступный.
 */
function dominantSymbol(slots: readonly DaySlot[]): string | undefined {
  const withSymbol = slots.filter(
    (slot): slot is DaySlot & { symbol: string } => slot.symbol !== undefined,
  );
  if (withSymbol.length === 0) return undefined;

  const daytime = withSymbol.filter((slot) => !slot.isNight);
  const pool = daytime.length > 0 ? daytime : withSymbol;

  return pool.reduce((worst, slot) =>
    severityOf(slot.symbol) > severityOf(worst.symbol) ? slot : worst,
  ).symbol;
}

/** Эвристика «плохости» по коду символа Foreca: интенсивность осадков важнее. */
export function severityOf(symbol: string): number {
  const rate = Number(symbol.charAt(2));
  const cloudiness = Number(symbol.charAt(1));
  return (Number.isNaN(rate) ? 0 : rate) * 10 + (Number.isNaN(cloudiness) ? 0 : cloudiness);
}

function roundMm(value: number): number {
  return Math.round(value * 10) / 10;
}

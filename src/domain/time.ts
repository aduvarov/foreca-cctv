/**
 * Работа со временем в часовом поясе локации без внешних зависимостей.
 *
 * Почему не `Date` напрямую: сервер и локация живут в разных поясах, а подписи
 * дней на кадре должны соответствовать поясу локации. `Intl.DateTimeFormat`
 * даёт нужные части без сторонних библиотек.
 */

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Проверяет, что пояс известен среде выполнения. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Разбирает момент времени в части календаря указанного пояса. */
export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
  };
}

/** Календарная дата в поясе локации в виде `YYYY-MM-DD` — ключ группировки. */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = toLocalParts(instant, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Индекс дня недели (0 — понедельник) для календарной даты без времени. */
export function weekdayIndex(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Некорректная дата: ${dateKey}`);
  }
  // Date.UTC + getUTCDay: пояс не участвует, важна только календарная дата.
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/** Сдвигает календарную дату на `days` дней, сохраняя формат `YYYY-MM-DD`. */
export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Некорректная дата: ${dateKey}`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Форматирует время обновления для кадра: `ДД.ММ ЧЧ:ММ` в поясе локации. */
export function formatUpdatedAt(instant: Date, timeZone: string): string {
  const parts = toLocalParts(instant, timeZone);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(parts.day)}.${two(parts.month)} ${two(parts.hour)}:${two(parts.minute)}`;
}

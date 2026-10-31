import { describe, expect, it } from 'vitest';

import type { ForecastStep } from '../src/foreca/client.js';
import { buildWeekChart, normalizeSteps, windowSteps } from '../src/domain/week-chart.js';
import { localDateKey } from '../src/domain/time.js';

const TZ = 'Asia/Almaty';
const location = {
  id: 1,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: TZ,
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

/**
 * Строит шаги, выровненные по локальной сетке: 00:00, 03:00, 06:00 … пояса Алматы.
 * Именно так выглядит ответ Foreca — сетка привязана к локации, а не к UTC.
 */
function localAlignedSteps(fromLocalDate: string, count: number): ForecastStep[] {
  // 00:00 в Алматы (UTC+5) = 19:00 UTC предыдущего дня.
  const startUtc = new Date(`${fromLocalDate}T00:00:00+05:00`).getTime();
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(startUtc + index * 3 * 60 * 60 * 1000);
    return {
      time: at.toISOString(),
      temperature: 5,
      symbol: 'd200',
      precipAccum: 0,
      windDir: 200,
      windSpeed: 3,
      cloudiness: 40,
    };
  });
}

describe('Окно прогноза на локальной сетке', () => {
  it('в 15:40 местного времени первый день начинается с шага 18:00', () => {
    // 15:40 в Алматы = 10:40 UTC.
    const now = new Date('2026-10-31T10:40:00Z');
    const steps = normalizeSteps(localAlignedSteps('2026-10-31', 64), TZ);

    const windowed = windowSteps(steps, now, TZ);
    const first = windowed[0];

    expect(first).toBeDefined();
    // 18:00 по Алматы = 13:00 UTC.
    expect(first!.at.toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(first!.at.toISOString()).toContain('13:00');
  });

  it('в 15:40 первый день содержит только оставшиеся шаги суток', () => {
    const now = new Date('2026-10-31T10:40:00Z');
    // buildWeekChart принимает сырые шаги: нормализацию он делает сам.
    const chart = buildWeekChart({
      location,
      steps: localAlignedSteps('2026-10-31', 64),
      now,
      updatedAt: now,
    });

    const firstDay = chart.days[0];
    expect(firstDay).toBeDefined();
    expect(firstDay!.isPartial).toBe(true);
    // После 15:40 в сутках остаются 18:00 и 21:00.
    expect(firstDay!.slots.map((slot) => slot.hour)).toEqual([18, 21]);
  });

  it('шаг ровно в текущую минуту считается будущим', () => {
    // 15:00 ровно: шаг 15:00 ещё актуален, окно начинается с него.
    const now = new Date('2026-10-31T10:00:00Z');
    const steps = normalizeSteps(localAlignedSteps('2026-10-31', 16), TZ);

    const windowed = windowSteps(steps, now, TZ);
    expect(windowed[0]?.at.toISOString()).toBe('2026-10-31T10:00:00.000Z');
  });

  it('семь дней считаются от даты первого шага, а не от даты «сейчас»', () => {
    // 23:30 местного: ближайший шаг — 00:00 следующего дня, и первым днём
    // должен стать он, а не день, в котором находится «сейчас».
    const now = new Date('2026-10-31T18:30:00Z');
    const steps = normalizeSteps(localAlignedSteps('2026-10-31', 64), TZ);

    const windowed = windowSteps(steps, now, TZ);
    const first = windowed[0];

    expect(first).toBeDefined();
    expect(localDateKey(first!.at, TZ)).toBe('2026-11-01');
    expect(localDateKey(windowed[windowed.length - 1]!.at, TZ)).toBe('2026-11-07');
  });
});

import { describe, expect, it } from 'vitest';

import type { ForecastStep } from '../src/foreca/client.js';
import {
  DAYS_IN_VIEW,
  buildWeekChart,
  groupByDate,
  normalizeSteps,
  severityOf,
  sumPrecipitation,
  toWindView,
  windowSteps,
} from '../src/domain/week-chart.js';
import { addDays, formatUpdatedAt, localDateKey, weekdayIndex } from '../src/domain/time.js';

const TZ = 'Asia/Almaty';

/** Строит равномерную сетку 3-часовых шагов от заданного момента. */
function stepsFrom(startIso: string, count: number): ForecastStep[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(start + index * 3 * 60 * 60 * 1000);
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

const location = {
  id: 1,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: TZ,
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

describe('localDateKey и weekdayIndex', () => {
  it('дата считается в поясе локации, а не хоста', () => {
    // 21:00 UTC 31 октября — это 02:00 1 ноября в Алматы.
    expect(localDateKey(new Date('2026-10-31T21:00:00Z'), TZ)).toBe('2026-11-01');
    expect(localDateKey(new Date('2026-10-31T21:00:00Z'), 'UTC')).toBe('2026-10-31');
  });

  it('индекс дня недели считает понедельник нулём', () => {
    expect(weekdayIndex('2026-10-31')).toBe(5); // суббота
    expect(weekdayIndex('2026-11-01')).toBe(6); // воскресенье
    expect(weekdayIndex('2026-11-02')).toBe(0); // понедельник
  });

  it('addDays корректно переходит между месяцами и годами', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('formatUpdatedAt выводит ДД.ММ ЧЧ:ММ в поясе локации', () => {
    expect(formatUpdatedAt(new Date('2026-10-31T11:58:00Z'), TZ)).toBe('31.10 16:58');
  });
});

describe('normalizeSteps', () => {
  it('отбрасывает шаги без времени или температуры', () => {
    const steps: ForecastStep[] = [
      {
        time: '2026-10-31T00:00:00Z',
        temperature: 5,
        symbol: 'd200',
        precipAccum: 0,
        windDir: 0,
        windSpeed: 1,
        cloudiness: 0,
      },
      {
        time: undefined,
        temperature: 4,
        symbol: undefined,
        precipAccum: undefined,
        windDir: undefined,
        windSpeed: undefined,
        cloudiness: undefined,
      },
      {
        time: '2026-10-31T03:00:00Z',
        temperature: undefined,
        symbol: undefined,
        precipAccum: undefined,
        windDir: undefined,
        windSpeed: undefined,
        cloudiness: undefined,
      },
      {
        time: 'не дата',
        temperature: 7,
        symbol: undefined,
        precipAccum: undefined,
        windDir: undefined,
        windSpeed: undefined,
        cloudiness: undefined,
      },
    ];

    expect(normalizeSteps(steps, TZ)).toHaveLength(1);
  });

  it('сортирует шаги по времени', () => {
    const steps: ForecastStep[] = [
      {
        time: '2026-10-31T06:00:00Z',
        temperature: 2,
        symbol: undefined,
        precipAccum: undefined,
        windDir: undefined,
        windSpeed: undefined,
        cloudiness: undefined,
      },
      {
        time: '2026-10-31T00:00:00Z',
        temperature: 1,
        symbol: undefined,
        precipAccum: undefined,
        windDir: undefined,
        windSpeed: undefined,
        cloudiness: undefined,
      },
    ];

    const normalized = normalizeSteps(steps, TZ);
    expect(normalized.map((step) => step.temperature)).toEqual([1, 2]);
  });

  it('падает на неизвестном часовом поясе', () => {
    expect(() => normalizeSteps(stepsFrom('2026-10-31T00:00:00Z', 1), 'Mars/Olympus')).toThrow();
  });
});

describe('windowSteps', () => {
  // 15:40 в Алматы = 10:40 UTC. Ближайший шаг — 12:00 UTC (17:00 местного).
  const now = new Date('2026-10-31T10:40:00Z');

  it('начинает окно с ближайшего шага, а не с начала сетки', () => {
    const steps = normalizeSteps(stepsFrom('2026-10-31T00:00:00Z', 32), TZ);
    const windowed = windowSteps(steps, now, TZ);

    const first = windowed[0];
    expect(first).toBeDefined();
    expect(first!.at.toISOString()).toBe('2026-10-31T12:00:00.000Z');
  });

  it('покрывает ровно семь календарных дней', () => {
    const steps = normalizeSteps(stepsFrom('2026-10-31T00:00:00Z', 70), TZ);
    const windowed = windowSteps(steps, now, TZ);

    const first = windowed[0];
    expect(first).toBeDefined();
    const firstKey = localDateKey(first!.at, TZ);
    const last = windowed[windowed.length - 1];
    expect(last).toBeDefined();
    expect(localDateKey(last!.at, TZ)).toBe(addDays(firstKey, DAYS_IN_VIEW - 1));
  });

  it('возвращает пустое окно, если все шаги в прошлом', () => {
    const steps = normalizeSteps(stepsFrom('2026-10-01T00:00:00Z', 8), TZ);
    expect(windowSteps(steps, now, TZ)).toEqual([]);
  });
});

describe('groupByDate', () => {
  it('группирует по календарным датам локации', () => {
    const steps = normalizeSteps(stepsFrom('2026-10-31T00:00:00Z', 16), TZ);
    const groups = groupByDate(steps, TZ);

    expect([...groups.keys()]).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('sumPrecipitation', () => {
  it('складывает пары 3-часовых шагов в шестичасовые столбики', () => {
    const steps = normalizeSteps(
      [
        {
          time: '2026-10-31T00:00:00Z',
          temperature: 1,
          symbol: undefined,
          precipAccum: 0.1,
          windDir: undefined,
          windSpeed: undefined,
          cloudiness: undefined,
        },
        {
          time: '2026-10-31T03:00:00Z',
          temperature: 1,
          symbol: undefined,
          precipAccum: 0.2,
          windDir: undefined,
          windSpeed: undefined,
          cloudiness: undefined,
        },
        {
          time: '2026-10-31T06:00:00Z',
          temperature: 1,
          symbol: undefined,
          precipAccum: 0,
          windDir: undefined,
          windSpeed: undefined,
          cloudiness: undefined,
        },
        {
          time: '2026-10-31T09:00:00Z',
          temperature: 1,
          symbol: undefined,
          precipAccum: 1.45,
          windDir: undefined,
          windSpeed: undefined,
          cloudiness: undefined,
        },
      ],
      TZ,
    );

    const slots = sumPrecipitation(steps, TZ);

    expect(slots).toHaveLength(2);
    expect(slots[0]?.mm).toBeCloseTo(0.3, 5);
    expect(slots[1]?.mm).toBeCloseTo(1.5, 5);
  });
});

describe('toWindView', () => {
  it('разворачивает направление на 180 градусов: API говорит откуда дует', () => {
    const steps = normalizeSteps(stepsFrom('2026-10-31T00:00:00Z', 8), TZ);
    const wind = toWindView(steps, TZ);

    expect(wind).toBeDefined();
    expect(wind!.directionTo).toBe(20);
  });

  it('возвращает undefined без данных о ветре', () => {
    const steps = normalizeSteps(
      [
        {
          time: '2026-10-31T00:00:00Z',
          temperature: 1,
          symbol: undefined,
          precipAccum: undefined,
          windDir: undefined,
          windSpeed: undefined,
          cloudiness: undefined,
        },
      ],
      TZ,
    );
    expect(toWindView(steps, TZ)).toBeUndefined();
  });
});

describe('severityOf', () => {
  it('ставит осадки выше облачности', () => {
    expect(severityOf('d400')).toBeLessThan(severityOf('d210'));
    expect(severityOf('d220')).toBeLessThan(severityOf('d240'));
  });
});

describe('buildWeekChart', () => {
  const now = new Date('2026-10-31T10:40:00Z');

  it('строит семь дней и непрерывный ряд точек', () => {
    const chart = buildWeekChart({
      location,
      steps: stepsFrom('2026-10-31T09:00:00Z', 64),
      now,
      updatedAt: new Date('2026-10-31T10:30:00Z'),
    });

    expect(chart.days).toHaveLength(DAYS_IN_VIEW);
    expect(chart.points.length).toBeGreaterThan(chart.days.length);
    expect(chart.locationName).toBe('Караганда');
    expect(chart.timeZone).toBe(TZ);
    expect(chart.timeZoneResolved).toBe(true);
  });

  it('помечает первый день неполным', () => {
    const chart = buildWeekChart({
      location,
      steps: stepsFrom('2026-10-31T09:00:00Z', 64),
      now,
      updatedAt: new Date('2026-10-31T10:30:00Z'),
    });

    expect(chart.days[0]?.isPartial).toBe(true);
    expect(chart.days[1]?.isPartial).toBe(false);
  });

  it('считает экстремумы и осадки по дням', () => {
    // Окно начинается с индекса 1 (12:00Z), поэтому в первом дне индексы 1..3:
    // условие `% 3` гарантирует, что и минимум, и максимум попадут в первый день.
    const steps = stepsFrom('2026-10-31T09:00:00Z', 64).map((step, index) => ({
      ...step,
      temperature: index % 3 === 0 ? -3 : 7,
      precipAccum: index % 2 === 0 ? 0.5 : 0,
    }));

    const chart = buildWeekChart({
      location,
      steps,
      now,
      updatedAt: new Date('2026-10-31T10:30:00Z'),
    });

    const firstDay = chart.days[0];
    expect(firstDay).toBeDefined();
    expect(firstDay!.minTemperature).toBe(-3);
    expect(firstDay!.maxTemperature).toBe(7);
    expect(firstDay!.precipitationMm).toBeGreaterThan(0);
  });

  it('не придумывает дни, если данные короче недели', () => {
    const chart = buildWeekChart({
      location,
      steps: stepsFrom('2026-10-31T09:00:00Z', 10),
      now,
      updatedAt: new Date('2026-10-31T10:30:00Z'),
    });

    expect(chart.days.length).toBeLessThan(DAYS_IN_VIEW);
    expect(chart.days.every((day) => day.slots.length > 0)).toBe(true);
  });

  it('помечает устаревшие данные по порогу', () => {
    const fresh = buildWeekChart({
      location,
      steps: stepsFrom('2026-10-31T09:00:00Z', 64),
      now,
      updatedAt: new Date('2026-10-31T10:00:00Z'),
    });
    expect(fresh.stale).toBe(false);

    const stale = buildWeekChart({
      location,
      steps: stepsFrom('2026-10-31T09:00:00Z', 64),
      now,
      updatedAt: new Date('2026-10-31T07:00:00Z'),
      staleAfterMs: 60 * 60_000,
    });
    expect(stale.stale).toBe(true);
    expect(stale.ageMinutes).toBe(220);
  });

  it('строит пустую модель, если шагов нет', () => {
    const chart = buildWeekChart({
      location,
      steps: [],
      now,
      updatedAt: now,
    });

    expect(chart.days).toEqual([]);
    expect(chart.points).toEqual([]);
  });

  it('сообщает, что часовой пояс взят из фолбэка', () => {
    const chart = buildWeekChart({
      location: { ...location, timezone: undefined },
      steps: stepsFrom('2026-10-31T09:00:00Z', 64),
      now,
      updatedAt: now,
    });

    expect(chart.timeZoneResolved).toBe(false);
  });

  it('выбирает символ дня по худшим дневным условиям', () => {
    const steps = stepsFrom('2026-10-31T09:00:00Z', 64).map((step, index) => ({
      ...step,
      symbol: index === 8 ? 'd421' : 'd000',
    }));

    const chart = buildWeekChart({
      location,
      steps,
      now,
      updatedAt: now,
    });

    expect(chart.days[1]?.symbol).toBe('d421');
  });
});

/**
 * Фикстура недельной модели для тестов рендера.
 *
 * Строится через настоящий `buildWeekChart`, а не руками: иначе тесты рендера
 * перестанут замечать ошибки доменного слоя.
 */
import { buildWeekChart } from '../../src/domain/week-chart.js';
import type { WeekChart } from '../../src/domain/week-chart.js';
import type { ForecastStep } from '../../src/foreca/client.js';

const TZ = 'Asia/Almaty';
const START = new Date('2026-10-31T00:00:00+05:00').getTime();

export interface TestChartOptions {
  /** Подменить температуры: нужно для проверки шкалы. */
  readonly temperatures?: readonly number[];
  readonly now?: Date;
  readonly updatedAt?: Date;
  readonly locationName?: string;
}

export function createTestChart(options: TestChartOptions = {}): WeekChart {
  const steps: ForecastStep[] = Array.from({ length: 64 }, (_, index) => {
    const at = new Date(START + index * 3 * 60 * 60 * 1000);
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hour12: false,
        timeZone: TZ,
      }).format(at),
    );
    const isNight = hour < 7 || hour >= 19;
    const override = options.temperatures?.[index % (options.temperatures.length || 1)];

    return {
      time: at.toISOString(),
      temperature:
        override ?? Number((4 + 7 * Math.sin(((hour - 9) / 24) * Math.PI * 2)).toFixed(1)),
      symbol: `${isNight ? 'n' : 'd'}${index % 5 === 0 ? '421' : '200'}`,
      precipAccum: index % 7 === 0 ? 0.8 : 0,
      windDir: 200,
      windSpeed: 3,
      cloudiness: 40,
    };
  });

  return buildWeekChart({
    location: {
      id: 1,
      name: options.locationName ?? 'Караганда',
      country: 'Казахстан',
      timezone: TZ,
      adminArea: 'Карагандинская область',
      lon: 73.1094,
      lat: 49.8047,
    },
    steps,
    now: options.now ?? new Date('2026-10-31T10:40:00Z'),
    updatedAt: options.updatedAt ?? new Date('2026-10-31T10:30:00Z'),
  });
}

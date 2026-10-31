import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildWeekChart } from '../src/domain/week-chart.js';
import type { ForecastStep } from '../src/foreca/client.js';
import { createRenderer } from '../src/render/index.js';

/**
 * Рендерит демонстрационный кадр в файл: единственный способ проверить макет
 * глазами, не поднимая поток. Используется при правках вида.
 *
 * Запуск: npx tsx scripts/render-sample.ts [output.png]
 */

const TZ = 'Asia/Almaty';
const start = new Date('2026-10-31T00:00:00+05:00').getTime();

function step(index: number): ForecastStep {
  const at = new Date(start + index * 3 * 60 * 60 * 1000);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).format(at),
  );
  const isNight = hour < 7 || hour >= 19;
  const temperature = Number(
    (4 + 7 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + Math.floor(index / 8) * 0.6).toFixed(1),
  );
  const rainBurst = index > 16 && index < 22;
  return {
    time: at.toISOString(),
    temperature,
    symbol: `${isNight ? 'n' : 'd'}${rainBurst ? '421' : index % 7 === 0 ? '300' : index % 3 === 0 ? '200' : '000'}`,
    precipAccum: rainBurst ? 1.4 : index % 9 === 0 ? 0.3 : 0,
    windDir: 200 + (index % 6) * 10,
    windSpeed: 2 + (index % 4),
    cloudiness: 40,
  };
}

const steps = Array.from({ length: 64 }, (_, index) => step(index));
const now = new Date('2026-10-31T10:40:00Z');

const chart = buildWeekChart({
  location: {
    id: 1,
    name: 'Караганда',
    country: 'Казахстан',
    timezone: TZ,
    adminArea: 'Карагандинская область',
    lon: 73.1094,
    lat: 49.8047,
  },
  steps,
  now,
  updatedAt: new Date('2026-10-31T10:30:00Z'),
});

const renderer = await createRenderer();
const output = resolve(process.argv[2] ?? 'sample-frame.png');
writeFileSync(output, renderer.renderFrame(chart).encodeSync('png'));
console.log(`кадр записан: ${output}`);

const stale = buildWeekChart({
  location: {
    id: 1,
    name: 'Караганда',
    country: 'Казахстан',
    timezone: TZ,
    adminArea: 'Карагандинская область',
    lon: 73.1094,
    lat: 49.8047,
  },
  steps,
  now,
  updatedAt: new Date('2026-10-31T05:00:00Z'),
});
writeFileSync(resolve('sample-frame-stale.png'), renderer.renderFrame(stale).encodeSync('png'));
console.log('кадр с устаревшими данными: sample-frame-stale.png');

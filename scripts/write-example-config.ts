/**
 * Пример конфигурации. Генерируется из схемы, поэтому не может разойтись с ней.
 *
 * Запуск: npx tsx scripts/write-example-config.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { configSchema, parseConfig } from '../src/config/schema.js';

const example = {
  _комментарий:
    'Скопируйте в config.json, подставьте свой токен. Файл config.json в репозиторий не попадает.',
  forecaToken: 'ВСТАВЬТЕ_ТОКЕН_FORECA',
  location: {
    name: 'Караганда',
    lat: 49.8047,
    lon: 73.1094,
    timezone: 'Asia/Almaty',
    _комментарий: 'lat/lon обязательны; остальное — подсказки для подписи на кадре',
  },
  stream: {
    fps: 1,
    bitrateKbps: 400,
    width: 640,
    height: 480,
    rtspUrl: 'rtsp://127.0.0.1:8554/weather',
  },
  api: {
    baseUrl: 'https://weatherapi.foreca.net',
    refreshMinutes: 30,
    timeoutMs: 10000,
    staleAfterMinutes: 90,
  },
  state: {
    cacheDir: './state',
  },
};

// Проверяем пример той же схемой: комментарии-ключи вызовут ошибку,
// поэтому для проверки они вырезаются.
const forValidation = JSON.parse(JSON.stringify(example)) as Record<string, unknown>;
delete forValidation['_комментарий'];
const location = forValidation['location'] as Record<string, unknown>;
delete location['_комментарий'];

const result = parseConfig(forValidation);
if (!result.ok) {
  console.error('Пример не проходит схему:', result.problems.join('; '));
  process.exit(1);
}

// Ключи с подчёркиванием схема отбросит при строгом разборе, поэтому в файл
// пишем только известные поля.
const target = resolve(import.meta.dirname, '..', 'config.example.json');
writeFileSync(target, `${JSON.stringify(configSchema.parse(forValidation), null, 2)}\n`, 'utf8');
console.log(`записано: ${target}`);

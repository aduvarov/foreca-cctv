/**
 * Генерация offline-заглушки в assets/.
 *
 * Запуск: npx tsx scripts/make-offline-video.ts
 *
 * Файл коммитится: от него зависит доступность канала до первой публикации,
 * и генерировать его при старте сервиса нельзя.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOfflineCommand, generateOfflineVideo } from '../src/stream/offline.js';

const output = resolve(import.meta.dirname, '..', 'assets', 'offline', 'no-data.mp4');
mkdirSync(resolve(import.meta.dirname, '..', 'assets', 'offline'), { recursive: true });

const command = buildOfflineCommand({
  output,
  width: 704,
  height: 576,
  fps: 1,
  seconds: 6,
  fontPath: resolve(import.meta.dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf'),
});

console.log(`ffmpeg ${command.args.join(' ')}`);
await generateOfflineVideo({
  output,
  width: 704,
  height: 576,
  fps: 1,
  seconds: 6,
  fontPath: resolve(import.meta.dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf'),
});
console.log(`заглушка создана: ${output}`);

import { describe, expect, it } from 'vitest';

import { startEncoder } from '../src/stream/encoder.js';
import type { EncoderEvent } from '../src/stream/encoder.js';

/**
 * Проверки на живом дочернем процессе.
 *
 * Ключевой сценарий: FFmpeg умирает, запись в stdin даёт EPIPE. Ошибка
 * приходит событием `'error'` на поток, а не исключением из `write()`,
 * поэтому без обработчика она роняет весь сервис. Здесь проверяется, что
 * процесс не падает, а супервизор получает событие о завершении.
 */
const frame = new Uint8Array(704 * 576 * 4);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ждёт выполнения условия или сдаётся по таймауту. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(10);
  }
}

describe('startEncoder: живой процесс', () => {
  it('не роняет процесс при EPIPE и сообщает о завершении', async () => {
    const events: EncoderEvent[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.once('uncaughtException', onUncaught);

    try {
      // `false` завершается сразу, не читая stdin: тот же сценарий, что и
      // упавший FFmpeg, но без запуска настоящего кодировщика.
      const encoder = startEncoder({
        rtspUrl: 'rtsp://127.0.0.1:8554/weather',
        width: 704,
        height: 576,
        fps: 1,
        bitrateKbps: 400,
        ffmpegPath: 'false',
        onEvent: (event) => {
          events.push(event);
        },
      });

      encoder.write(frame);
      await waitFor(() => events.some((event) => event.type === 'exited'));
      // Даём EPIPE дойти до потока stdin.
      await sleep(100);

      expect(uncaught).toHaveLength(0);
      expect(events.some((event) => event.type === 'exited')).toBe(true);
      expect(encoder.running).toBe(false);
      // После падения запись возвращает отказ, а не бросает исключение.
      expect(encoder.write(frame).ok).toBe(false);

      await encoder.stop();
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('считает кодировщик неработающим после ошибки запуска', async () => {
    const events: EncoderEvent[] = [];
    const encoder = startEncoder({
      rtspUrl: 'rtsp://127.0.0.1:8554/weather',
      width: 704,
      height: 576,
      fps: 1,
      bitrateKbps: 400,
      ffmpegPath: '/nonexistent-ffmpeg-binary',
      onEvent: (event) => {
        events.push(event);
      },
    });

    // ENOENT не даёт события `exit`: без подстраховки через `close`
    // супервизор не узнал бы о падении и не перезапустил публикацию.
    await waitFor(() => events.some((event) => event.type === 'exited'));

    expect(encoder.running).toBe(false);
    expect(events.some((event) => event.type === 'exited')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(encoder.write(frame).ok).toBe(false);

    await encoder.stop();
  });
});

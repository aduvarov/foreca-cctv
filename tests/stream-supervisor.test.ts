import { describe, expect, it, vi } from 'vitest';

import { EncoderSupervisor } from '../src/stream/supervisor.js';
import type {
  EncoderEvent,
  EncoderHandle,
  StartEncoderOptions,
  WriteResult,
} from '../src/stream/encoder.js';

/**
 * Заглушка кодировщика.
 *
 * Контракт `startEncoder`: события приходят через `onEvent`, а не через
 * события объекта handle. Поэтому заглушка запоминает колбэк и вызывает его.
 */
interface FakeEncoder {
  readonly handle: EncoderHandle;
  readonly write: ReturnType<typeof vi.fn>;
  emitExit(code: number | null): void;
}

function fakeEncoder(options: StartEncoderOptions): FakeEncoder {
  let running = true;
  const write = vi.fn((frame: Uint8Array): WriteResult => {
    // Кадр не важен, но сигнатура требует параметр.
    expect(frame).toBeInstanceOf(Uint8Array);
    return { ok: true, backpressure: false };
  });

  const handle: EncoderHandle = {
    pid: 1234,
    get running() {
      return running;
    },
    write,
    stop(): Promise<void> {
      running = false;
      return Promise.resolve();
    },
  };

  options.onEvent?.({ type: 'started', pid: 1234 });

  return {
    handle,
    write,
    emitExit(code: number | null) {
      running = false;
      const event: EncoderEvent = { type: 'exited', code, signal: null };
      options.onEvent?.(event);
    },
  };
}

describe('EncoderSupervisor', () => {
  function setup(): {
    supervisor: EncoderSupervisor;
    encoders: FakeEncoder[];
    timers: { callback: () => void; delay: number }[];
    events: string[];
    runTimer: (index?: number) => void;
  } {
    const encoders: FakeEncoder[] = [];
    const timers: { callback: () => void; delay: number }[] = [];
    const events: string[] = [];

    const supervisor = new EncoderSupervisor({
      encoder: {
        rtspUrl: 'rtsp://127.0.0.1:8554/weather',
        width: 640,
        height: 480,
        fps: 1,
        bitrateKbps: 400,
      },
      baseDelayMs: 100,
      maxDelayMs: 800,
      startImpl: (options) => {
        const fake = fakeEncoder(options);
        encoders.push(fake);
        return fake.handle;
      },
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
      onEvent: (event) => events.push(event.type),
    });

    return {
      supervisor,
      encoders,
      timers,
      events,
      runTimer: (index = -1) => {
        const timer = index < 0 ? timers.at(-1) : timers[index];
        timer?.callback();
      },
    };
  }

  it('запускает кодировщик и сообщает о старте один раз', () => {
    const { supervisor, encoders, events } = setup();

    supervisor.start();

    expect(encoders).toHaveLength(1);
    expect(events.filter((type) => type === 'started')).toHaveLength(1);
  });

  it('не запускает второй процесс при повторном start()', () => {
    const { supervisor, encoders } = setup();

    supervisor.start();
    supervisor.start();

    expect(encoders).toHaveLength(1);
  });

  it('перезапускает кодировщик после падения с задержкой', () => {
    const { supervisor, encoders, timers, runTimer } = setup();
    supervisor.start();

    encoders[0]?.emitExit(1);

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(100);
    expect(supervisor.state.running).toBe(false);

    runTimer();

    expect(encoders).toHaveLength(2);
    expect(supervisor.state.restarts).toBe(1);
  });

  it('увеличивает задержку при серии падений', () => {
    const { supervisor, encoders, timers, runTimer } = setup();
    supervisor.start();

    encoders[0]?.emitExit(1);
    runTimer();
    encoders[1]?.emitExit(1);

    expect(timers.map((timer) => timer.delay)).toEqual([100, 200]);
  });

  it('не превышает предел задержки', () => {
    const { supervisor, encoders, timers, runTimer } = setup();
    supervisor.start();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      encoders.at(-1)?.emitExit(1);
      runTimer();
    }

    expect(Math.max(...timers.map((timer) => timer.delay))).toBeLessThanOrEqual(800);
  });

  it('сбрасывает серию падений после здоровой работы', () => {
    const { supervisor, encoders, timers, runTimer } = setup();
    supervisor.start();

    encoders[0]?.emitExit(1);
    runTimer();
    supervisor.noteHealthy();
    encoders[1]?.emitExit(1);

    expect(timers[1]?.delay).toBe(100);
  });

  it('отдаёт кадр кодировщику и запоминает время последнего кадра', () => {
    const { supervisor, encoders } = setup();
    supervisor.start();

    const result = supervisor.write(new Uint8Array([1, 2, 3]));

    expect(result.ok).toBe(true);
    expect(encoders[0]?.write).toHaveBeenCalledOnce();
    expect(supervisor.state.lastFrameAt).toBeInstanceOf(Date);
  });

  it('сообщает об отказе, если кодировщика нет', () => {
    const { supervisor } = setup();

    const result = supervisor.write(new Uint8Array([1]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('не запущен');
  });

  it('считает backpressure успешной записью', () => {
    const events: string[] = [];
    const supervisor = new EncoderSupervisor({
      encoder: {
        rtspUrl: 'rtsp://x/weather',
        width: 640,
        height: 480,
        fps: 1,
        bitrateKbps: 400,
      },
      startImpl: (options) => {
        options.onEvent?.({ type: 'started', pid: 1 });
        return {
          pid: 1,
          running: true,
          write: () => ({ ok: true, backpressure: true }),
          stop: () => Promise.resolve(),
        };
      },
      onEvent: (event) => events.push(event.type),
    });
    supervisor.start();

    const result = supervisor.write(new Uint8Array([1]));

    // Крупный кадр всегда больше highWaterMark: backpressure — не отказ.
    expect(result.ok).toBe(true);
    expect(events).toContain('started');
  });

  it('после stop() не перезапускает кодировщик', async () => {
    const { supervisor, encoders, timers, runTimer } = setup();
    supervisor.start();

    encoders[0]?.emitExit(1);
    await supervisor.stop();
    runTimer();

    expect(encoders).toHaveLength(1);
    expect(supervisor.state.stopped).toBe(true);
    expect(timers.length).toBeGreaterThan(0);
  });

  it('запоминает текст ошибки кодировщика', () => {
    const { supervisor, encoders } = setup();
    supervisor.start();

    encoders[0]?.emitExit(2);

    expect(supervisor.state.lastError).toContain('с кодом 2');
  });

  it('сообщает об ошибке запуска, не падая', async () => {
    const events: string[] = [];
    const supervisor = new EncoderSupervisor({
      encoder: {
        rtspUrl: 'rtsp://x/weather',
        width: 640,
        height: 480,
        fps: 1,
        bitrateKbps: 400,
      },
      startImpl: (options) => {
        options.onEvent?.({ type: 'started', pid: 1 });
        // Ошибка spawn приходит асинхронно, уже после возврата handle.
        setTimeout(() => {
          options.onEvent?.({ type: 'error', error: new Error('ffmpeg не найден') });
        }, 0);
        return {
          pid: 1,
          running: true,
          write: () => ({ ok: true, backpressure: false }),
          stop: () => Promise.resolve(),
        };
      },
      onEvent: (event) => events.push(event.type),
    });

    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(events).toContain('started');
    expect(supervisor.state.running).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { FramePublisher } from '../src/stream/publisher.js';
import type { EncoderSupervisor } from '../src/stream/supervisor.js';
import type { WriteResult } from '../src/stream/encoder.js';

function fakeSupervisor(result: WriteResult = { ok: true, backpressure: false }): {
  supervisor: EncoderSupervisor;
  write: ReturnType<typeof vi.fn>;
  noteHealthy: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn((frame: Uint8Array) => {
    // Кадр не важен: проверяется факт вызова, но параметр нужен для сигнатуры.
    expect(frame).toBeInstanceOf(Uint8Array);
    return result;
  });
  const noteHealthy = vi.fn();
  return {
    supervisor: { write, noteHealthy } as unknown as EncoderSupervisor,
    write,
    noteHealthy,
  };
}

function frames(): { next: () => Uint8Array; calls: () => number } {
  let calls = 0;
  return {
    next: () => {
      calls += 1;
      return new Uint8Array([calls]);
    },
    calls: () => calls,
  };
}

describe('FramePublisher', () => {
  it('отправляет кадры с заданной частотой', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, write } = fakeSupervisor();
      const source = frames();
      const publisher = new FramePublisher({ supervisor, source, fps: 1 });

      publisher.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(write).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(write).toHaveBeenCalledTimes(3);

      await publisher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('считает отданные и пропущенные кадры', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor } = fakeSupervisor();
      const source = frames();
      const publisher = new FramePublisher({ supervisor, source, fps: 10 });

      publisher.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(publisher.ticks).toBe(5);
      expect(publisher.dropped).toBe(0);

      await publisher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('считает пропуском отказ кодировщика', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, noteHealthy } = fakeSupervisor({ ok: false, reason: 'нет процесса' });
      const publisher = new FramePublisher({ supervisor, source: frames(), fps: 10 });

      publisher.start();
      await vi.advanceTimersByTimeAsync(300);

      expect(publisher.ticks).toBe(0);
      expect(publisher.dropped).toBe(3);
      expect(noteHealthy).not.toHaveBeenCalled();

      await publisher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('не считает backpressure пропуском', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, noteHealthy } = fakeSupervisor({ ok: true, backpressure: true });
      const publisher = new FramePublisher({ supervisor, source: frames(), fps: 10 });

      publisher.start();
      await vi.advanceTimersByTimeAsync(200);

      expect(publisher.ticks).toBe(2);
      expect(publisher.dropped).toBe(0);
      expect(noteHealthy).toHaveBeenCalledTimes(2);

      await publisher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('после остановки не отправляет кадры', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, write } = fakeSupervisor();
      const publisher = new FramePublisher({ supervisor, source: frames(), fps: 10 });

      publisher.start();
      await vi.advanceTimersByTimeAsync(200);
      await publisher.stop();
      const before = write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(write.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('повторный start не запускает второй таймер', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, write } = fakeSupervisor();
      const publisher = new FramePublisher({ supervisor, source: frames(), fps: 10 });

      publisher.start();
      publisher.start();
      await vi.advanceTimersByTimeAsync(200);

      expect(write).toHaveBeenCalledTimes(2);
      await publisher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('сообщает о каждом успешном тике', async () => {
    vi.useFakeTimers();
    try {
      const ticks: Date[] = [];
      const { supervisor } = fakeSupervisor();
      const publisher = new FramePublisher({
        supervisor,
        source: frames(),
        fps: 10,
        onTick: (at) => ticks.push(at),
      });

      publisher.start();
      await vi.advanceTimersByTimeAsync(300);

      expect(ticks).toHaveLength(3);
      await publisher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

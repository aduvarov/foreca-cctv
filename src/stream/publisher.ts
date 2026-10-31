/**
 * Публикатор: соединяет источник кадров с супервизором кодировщика.
 *
 * Источник кадров ничего не знает про FFmpeg: он отдаёт `Uint8Array` RGBA.
 * Публикатор:
 *  - гонит кадры с заданной частотой;
 *  - не копит очередь, если кодировщик не успевает (лучше пропустить кадр,
 *    чем показывать вчерашнее);
 *  - остаётся живым, пока жив сервис, даже если публикация упала.
 */
import type { EncoderSupervisor } from './supervisor.js';

export interface FrameSource {
  /** Возвращает очередной кадр в RGBA. */
  next(): Uint8Array;
}

export interface PublisherOptions {
  readonly supervisor: EncoderSupervisor;
  readonly source: FrameSource;
  readonly fps: number;
  readonly onTick?: (at: Date) => void;
}

export interface Publisher {
  start(): void;
  stop(): Promise<void>;
  readonly ticks: number;
  readonly dropped: number;
}

export class FramePublisher implements Publisher {
  readonly #options: PublisherOptions;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #ticks = 0;
  #dropped = 0;

  constructor(options: PublisherOptions) {
    this.#options = options;
  }

  get ticks(): number {
    return this.#ticks;
  }

  get dropped(): number {
    return this.#dropped;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    const intervalMs = Math.max(1, Math.round(1000 / this.#options.fps));
    this.#timer = setInterval(() => {
      this.#tick();
    }, intervalMs);
    // Публикация не должна сама по себе удерживать процесс: остановкой
    // управляет сервис.
    this.#timer.unref();
  }

  stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    // Интерфейс возвращает Promise: в будущем здесь может появиться ожидание
    // последнего кадра, сейчас ждать нечего.
    return Promise.resolve();
  }

  #tick(): void {
    if (!this.#running) return;

    const frame = this.#options.source.next();
    const result = this.#options.supervisor.write(frame);

    if (!result.ok) {
      // Кадр не ушёл: MediaMTX показывает заглушку, ждём перезапуска.
      this.#dropped += 1;
      return;
    }

    this.#ticks += 1;
    this.#options.onTick?.(new Date());
    // Кодировщик принял кадр: серия падений сброшена.
    // Backpressure — не отказ: кадр уже в буфере кодировщика.
    this.#options.supervisor.noteHealthy();
  }
}

/**
 * Супервизор кодировщика: держит публикацию живой.
 *
 * Задачи:
 *  - перезапускать FFmpeg с экспоненциальной задержкой;
 *  - не размножать процессы при серии падений;
 *  - отдавать состояние для наблюдаемости;
 *  - не мешать штатной остановке.
 *
 * Таймеры и часы передаются снаружи: тесты идут без реального ожидания.
 */
import type { EncoderEvent, EncoderHandle, StartEncoderOptions, WriteResult } from './encoder.js';
import { startEncoder } from './encoder.js';

export interface SupervisorOptions {
  readonly encoder: Omit<StartEncoderOptions, 'onEvent'>;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onEvent?: (event: SupervisorEvent) => void;
  readonly startImpl?: (options: StartEncoderOptions) => EncoderHandle;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export type SupervisorEvent =
  | { readonly type: 'started'; readonly pid: number | undefined }
  | { readonly type: 'exited'; readonly code: number | null; readonly restarts: number }
  | { readonly type: 'stderr'; readonly line: string }
  | { readonly type: 'gave-up'; readonly restarts: number }
  | { readonly type: 'stopped' };

export interface SupervisorState {
  readonly running: boolean;
  readonly restarts: number;
  readonly lastFrameAt: Date | undefined;
  readonly lastError: string | undefined;
  readonly stopped: boolean;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export class EncoderSupervisor {
  readonly #options: SupervisorOptions;
  readonly #startImpl: (options: StartEncoderOptions) => EncoderHandle;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #handle: EncoderHandle | undefined;
  #timer: unknown;
  #restarts = 0;
  #lastFrameAt: Date | undefined;
  #lastError: string | undefined;
  #stopped = false;
  /** Защита от каскада: при серии падений задержка растёт до предела. */
  #consecutiveFailures = 0;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#startImpl = options.startImpl ?? startEncoder;
    this.#setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        // Супервизор не должен удерживать процесс живым.
        timer.unref();
        return timer;
      });
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as NodeJS.Timeout);
      });
  }

  get state(): SupervisorState {
    return {
      running: this.#handle?.running === true,
      restarts: this.#restarts,
      lastFrameAt: this.#lastFrameAt,
      lastError: this.#lastError,
      stopped: this.#stopped,
    };
  }

  /** Запускает кодировщик и подписывается на его завершение. */
  start(): void {
    if (this.#stopped || this.#handle !== undefined) return;
    this.#spawn();
  }

  /**
   * Отправляет кадр. `ok: false` означает, что кодировщика нет:
   * MediaMTX в этот момент показывает offline-заглушку.
   */
  write(frame: Uint8Array): WriteResult {
    const handle = this.#handle;
    if (handle === undefined) {
      return { ok: false, reason: 'кодировщик не запущен' };
    }
    const result = handle.write(frame);
    if (result.ok) this.#lastFrameAt = new Date();
    return result;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }

    const handle = this.#handle;
    this.#handle = undefined;
    if (handle !== undefined) {
      await handle.stop();
    }
    this.#options.onEvent?.({ type: 'stopped' });
  }

  #spawn(): void {
    const handle = this.#startImpl({
      ...this.#options.encoder,
      onEvent: (event) => {
        this.#onEncoderEvent(event);
      },
    });
    this.#handle = handle;
  }

  #onEncoderEvent(event: EncoderEvent): void {
    switch (event.type) {
      case 'stderr': {
        this.#options.onEvent?.({ type: 'stderr', line: event.line });
        return;
      }
      case 'error': {
        this.#lastError = event.error.message;
        return;
      }
      case 'exited': {
        this.#handle = undefined;
        if (this.#stopped) return;

        this.#restarts += 1;
        this.#consecutiveFailures += 1;
        this.#lastError =
          event.code === null
            ? `FFmpeg завершился по сигналу ${event.signal ?? 'неизвестно'}`
            : `FFmpeg завершился с кодом ${event.code}`;

        this.#options.onEvent?.({
          type: 'exited',
          code: event.code,
          restarts: this.#restarts,
        });

        const delay = this.#delay();
        this.#timer = this.#setTimer(() => {
          this.#timer = undefined;
          if (this.#stopped) return;
          this.#spawn();
          // Успешный старт ещё не значит стабильность, но следующий выход
          // увеличит счётчик снова — задержка продолжит расти.
        }, delay);
        return;
      }
      case 'started': {
        this.#options.onEvent?.({ type: 'started', pid: event.pid });
        return;
      }
      default: {
        // Все варианты EncoderEvent обработаны выше: сюда попасть нельзя,
        // но проверка типов требует исчерпывающего разбора.
        const exhaustive: never = event;
        throw new Error(`Неизвестное событие кодировщика: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Экспоненциальная задержка с пределом; сбрасывается при штатном кадре. */
  #delay(): number {
    const base = this.#options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const max = this.#options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const exponent = Math.max(0, this.#consecutiveFailures - 1);
    return Math.min(base * 2 ** exponent, max);
  }

  /** Отмечает, что публикация стабильна: сбрасывает серию падений. */
  noteHealthy(): void {
    this.#consecutiveFailures = 0;
  }
}

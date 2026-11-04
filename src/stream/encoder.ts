/**
 * Процесс публикации кадров в RTSP через FFmpeg.
 *
 * Решения, зафиксированные замерами (см. design.md):
 *  - `-tune zerolatency`: `stillimage` роняет публикацию через ~12 секунд;
 *  - `-g 1`: ключевой кадр на каждом, чтобы NVR подключался мгновенно;
 *  - `repeat-headers=1`: SPS/PPS в каждом ключевом кадре;
 *  - CBR: статичная картинка в VBR ужимается до 14–21 кбит/с, а NVR ждёт
 *    предсказуемый битрейт;
 *  - вход `rawvideo` RGBA через stdin: никаких временных файлов на кадр.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface EncoderOptions {
  readonly rtspUrl: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrateKbps: number;
  readonly ffmpegPath?: string;
  readonly level?: string;
  readonly profile?: string;
}

export interface EncoderCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Собирает командную строку отдельно от запуска: аргументы проверяются
 * тестами без запуска процесса.
 */
export function buildEncoderCommand(options: EncoderOptions): EncoderCommand {
  const { width, height, fps, bitrateKbps, rtspUrl } = options;
  const level = options.level ?? '3.1';
  const profile = options.profile ?? 'main';

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    // Вход: сырые RGBA-кадры.
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
    // Выход: H.264 для аппаратного регистратора.
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-profile:v',
    profile,
    '-level',
    level,
    '-pix_fmt',
    'yuv420p',
    '-bf',
    '0',
    '-g',
    '1',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1:repeat-headers=1',
    '-b:v',
    `${bitrateKbps}k`,
    '-minrate',
    `${bitrateKbps}k`,
    '-maxrate',
    `${bitrateKbps}k`,
    '-bufsize',
    `${bitrateKbps * 2}k`,
    '-f',
    'rtsp',
    '-rtsp_transport',
    'tcp',
    rtspUrl,
  ];

  return { command: options.ffmpegPath ?? 'ffmpeg', args };
}

export type EncoderEvent =
  | { readonly type: 'started'; readonly pid: number | undefined }
  | {
      readonly type: 'exited';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: 'error'; readonly error: Error }
  | { readonly type: 'stderr'; readonly line: string };

/** Результат записи кадра. */
export type WriteResult =
  | { readonly ok: true; readonly backpressure: boolean }
  | { readonly ok: false; readonly reason: string };

export interface EncoderHandle {
  write(frame: Uint8Array): WriteResult;
  stop(): Promise<void>;
  readonly pid: number | undefined;
  readonly running: boolean;
}

export interface StartEncoderOptions extends EncoderOptions {
  readonly onEvent?: (event: EncoderEvent) => void;
  readonly spawnImpl?: typeof spawn;
}

/**
 * Запускает FFmpeg и отдаёт handle для записи кадров.
 *
 * Ошибки FFmpeg не бросаются наружу: супервизор подписывается на события
 * и решает, перезапускать ли. Исключение здесь означало бы падение сервиса
 * из-за проблем с кодировщиком — а поток должен продолжаться.
 */
export function startEncoder(options: StartEncoderOptions): EncoderHandle {
  const { command, args } = buildEncoderCommand(options);
  const spawnImpl = options.spawnImpl ?? spawn;

  // stdout намеренно игнорируется: FFmpeg не пишет туда ничего полезного,
  // а невычитанный pipe мог бы заблокировать процесс.
  const child: ChildProcessByStdio<Writable, null, Readable> = spawnImpl(command, [...args], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const onEvent = options.onEvent;
  onEvent?.({ type: 'started', pid: child.pid });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString('utf8');
    let newlineIndex = stderrBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stderrBuffer.slice(0, newlineIndex).trimEnd();
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) onEvent?.({ type: 'stderr', line });
      newlineIndex = stderrBuffer.indexOf('\n');
    }
  });

  let exited = false;

  /**
   * Сообщает о завершении ровно один раз.
   *
   * `exit` не приходит, если процесс так и не запустился (например, `ENOENT`
   * от отсутствующего ffmpeg): тогда остаётся только `close`. Без этой
   * подстраховки супервизор не узнал бы о падении и не перезапустил публикацию.
   */
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    onEvent?.({ type: 'exited', code, signal });
  };

  child.on('error', (error) => {
    onEvent?.({ type: 'error', error });
  });

  child.on('exit', (code, signal) => {
    finish(code, signal);
  });

  // `close` приходит и после `exit`, и вместо него при ошибке запуска.
  child.on('close', (code, signal) => {
    finish(code, signal);
  });

  let stopped = false;
  let stdinFailure: Error | undefined;

  /**
   * Ошибка записи в stdin приходит событием `'error'`, а не исключением из
   * `write()`: EPIPE случается, когда FFmpeg уже умер. Без обработчика это
   * `uncaughtException` и падение всего сервиса вместо перезапуска кодировщика.
   */
  child.stdin.on('error', (error: Error) => {
    stdinFailure = error;
    onEvent?.({ type: 'error', error });
  });

  return {
    get pid() {
      return child.pid;
    },
    get running() {
      return (
        !stopped &&
        stdinFailure === undefined &&
        child.exitCode === null &&
        child.signalCode === null
      );
    },
    write(frame: Uint8Array): WriteResult {
      if (stdinFailure !== undefined) {
        return { ok: false, reason: `pipe кодировщика закрыт: ${stdinFailure.message}` };
      }
      if (!this.running || !child.stdin.writable) {
        return { ok: false, reason: 'кодировщик не запущен' };
      }
      try {
        // Крупный кадр почти всегда больше highWaterMark, поэтому `false`
        // означает backpressure, а не ошибку: данные уже приняты в буфер.
        const backpressure = !child.stdin.write(frame);
        return { ok: true, backpressure };
      } catch {
        // Запись в закрытый pipe — штатный сценарий при падении FFmpeg.
        return { ok: false, reason: 'pipe кодировщика закрыт' };
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      // Даём FFmpeg время корректно закрыть поток, затем добиваем.
      await new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2_000);
        // `close`, а не `exit`: при ошибке запуска процесса `exit` не приходит.
        child.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill('SIGTERM');
      });
    },
  };
}

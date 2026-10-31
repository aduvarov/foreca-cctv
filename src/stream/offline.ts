/**
 * Генерация offline-заглушки для MediaMTX.
 *
 * Заглушка обязана совпадать с живым потоком по разрешению, профилю, уровню
 * и формату пикселей: иначе при переключении читатель перестраивает декодер,
 * и на регистраторе это выглядит как рывок или артефакт.
 *
 * Файл создаётся один раз и коммитится, а не генерируется при старте сервиса:
 * от него зависит доступность канала до первой публикации.
 */
import { spawn } from 'node:child_process';

export interface OfflineVideoOptions {
  readonly output: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds?: number;
  readonly fontPath?: string;
  readonly ffmpegPath?: string;
}

export interface OfflineCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Собирает команду. Отдельно от запуска: аргументы проверяются тестом.
 *
 * Текст заглушки дублируется на русском и латиницей: часть регистраторов
 * не умеет отображать кириллицу в служебных сообщениях, а оператор должен
 * понимать, что канал не сломан.
 */
export function buildOfflineCommand(options: OfflineVideoOptions): OfflineCommand {
  const { output, width, height, fps } = options;
  const seconds = options.seconds ?? 6;
  const font = options.fontPath ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  const text = 'НЕТ ДАННЫХ / NO DATA';
  const subtitle = 'канал работает, ждём прогноз';

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x0a1120:s=${width}x${height}:r=${fps}`,
    '-vf',
    [
      `drawtext=fontfile=${font}:text='${text}':fontsize=${Math.round(height / 14)}:fontcolor=0xdbe4f0:x=(w-text_w)/2:y=(h-text_h)/2-20`,
      `drawtext=fontfile=${font}:text='${subtitle}':fontsize=${Math.round(height / 28)}:fontcolor=0x7c8ca6:x=(w-text_w)/2:y=(h-text_h)/2+30`,
    ].join(','),
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-profile:v',
    'main',
    '-level',
    '3.1',
    '-pix_fmt',
    'yuv420p',
    '-bf',
    '0',
    '-g',
    '1',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1:repeat-headers=1',
    '-b:v',
    '200k',
    '-r',
    String(fps),
    '-f',
    'mp4',
    '-y',
    output,
  ];

  return { command: options.ffmpegPath ?? 'ffmpeg', args };
}

/** Запускает генерацию и ждёт завершения. */
export function generateOfflineVideo(options: OfflineVideoOptions): Promise<void> {
  const { command, args } = buildOfflineCommand(options);

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg не смог создать заглушку (код ${String(code)}): ${stderr}`));
    });
  });
}

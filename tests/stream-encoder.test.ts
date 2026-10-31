import { describe, expect, it } from 'vitest';

import { buildEncoderCommand } from '../src/stream/encoder.js';
import { buildOfflineCommand } from '../src/stream/offline.js';

describe('buildEncoderCommand', () => {
  const command = buildEncoderCommand({
    rtspUrl: 'rtsp://127.0.0.1:8554/weather',
    width: 640,
    height: 480,
    fps: 1,
    bitrateKbps: 400,
  });

  const args = [...command.args];

  // Некоторые флаги встречаются дважды (вход и выход): берём последний,
  // потому что проверяем параметры кодирования, а не входного формата.
  function valueAfter(flag: string): string | undefined {
    const index = args.lastIndexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  }

  it('читает RGBA-кадры из stdin', () => {
    // Входные флаги идут до `-i pipe:0`, поэтому берём первое вхождение.
    function inputValue(flag: string): string | undefined {
      const index = args.indexOf(flag);
      return index < 0 ? undefined : args[index + 1];
    }

    expect(inputValue('-f')).toBe('rawvideo');
    expect(inputValue('-pix_fmt')).toBe('rgba');
    expect(inputValue('-s')).toBe('640x480');
    expect(inputValue('-r')).toBe('1');
    expect(inputValue('-i')).toBe('pipe:0');
  });

  it('использует zerolatency, а не stillimage', () => {
    // stillimage роняет RTSP-публикацию через ~12 секунд — проверено замерами.
    expect(valueAfter('-tune')).toBe('zerolatency');
    expect(args).not.toContain('stillimage');
  });

  it('ставит ключевой кадр на каждом кадре', () => {
    expect(valueAfter('-g')).toBe('1');
  });

  it('повторяет SPS/PPS в каждом ключевом кадре', () => {
    expect(valueAfter('-x264-params')).toContain('repeat-headers=1');
  });

  it('работает в CBR', () => {
    const params = valueAfter('-x264-params') ?? '';
    expect(params).toContain('nal-hrd=cbr');
    expect(params).toContain('force-cfr=1');
    expect(valueAfter('-b:v')).toBe('400k');
    expect(valueAfter('-minrate')).toBe('400k');
    expect(valueAfter('-maxrate')).toBe('400k');
    expect(valueAfter('-bufsize')).toBe('800k');
  });

  it('не содержит B-кадров и звука', () => {
    expect(valueAfter('-bf')).toBe('0');
    expect(args).toContain('-an');
  });

  it('использует Main и уровень не выше 3.1', () => {
    expect(valueAfter('-profile:v')).toBe('main');
    expect(valueAfter('-level')).toBe('3.1');
    expect(valueAfter('-pix_fmt')).toBe('yuv420p');
  });

  it('публикует по RTSP/TCP', () => {
    const outputFormatIndex = args.lastIndexOf('-f');
    expect(args[outputFormatIndex + 1]).toBe('rtsp');
    expect(valueAfter('-rtsp_transport')).toBe('tcp');
    expect(args.at(-1)).toBe('rtsp://127.0.0.1:8554/weather');
  });

  it('не пишет временных файлов: выход только в RTSP', () => {
    expect(args).not.toContain('-y');
    expect(args.join(' ')).not.toMatch(/\.(mp4|ts|mkv|png)/);
  });
});

describe('buildOfflineCommand', () => {
  const command = buildOfflineCommand({
    output: '/tmp/offline.mp4',
    width: 640,
    height: 480,
    fps: 1,
  });

  const args = [...command.args];

  it('использует те же параметры кодирования, что живой поток', () => {
    function valueAfter(flag: string, list: readonly string[]): string | undefined {
      const index = list.indexOf(flag);
      return index < 0 ? undefined : list[index + 1];
    }

    expect(valueAfter('-profile:v', args)).toBe('main');
    expect(valueAfter('-level', args)).toBe('3.1');
    expect(valueAfter('-pix_fmt', args)).toBe('yuv420p');
    expect(valueAfter('-bf', args)).toBe('0');
    expect(valueAfter('-g', args)).toBe('1');
    expect(valueAfter('-r', args)).toBe('1');
  });

  it('совпадает по размеру с живым потоком', () => {
    expect(args.join(' ')).toContain('s=640x480');
  });

  it('содержит понятный текст для оператора', () => {
    const filter = args[args.indexOf('-vf') + 1] ?? '';
    expect(filter).toContain('НЕТ ДАННЫХ');
    expect(filter).toContain('NO DATA');
  });

  it('пишет в mp4', () => {
    expect(args).toContain('mp4');
    expect(args.at(-1)).toBe('/tmp/offline.mp4');
  });
});

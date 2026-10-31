import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function readAsset(relativePath: string): Buffer {
  return readFileSync(join(root, relativePath));
}

describe('обязательные ресурсы репозитория', () => {
  it('шрифт с кириллицей присутствует и не пуст', () => {
    const path = 'assets/fonts/NotoSans-Regular.ttf';
    expect(statSync(join(root, path)).size).toBeGreaterThan(100_000);
    const head = readAsset(path).subarray(0, 4).toString('latin1');
    expect(['\u0000\u0001\u0000\u0000', 'true', 'OTTO', 'ttcf']).toContain(head);
  });

  it('жирное начертание шрифта присутствует и не пуст', () => {
    expect(statSync(join(root, 'assets/fonts/NotoSans-Bold.ttf')).size).toBeGreaterThan(100_000);
  });

  it('лицензия шрифта приложена', () => {
    const text = readAsset('assets/fonts/OFL.txt').toString('utf8');
    expect(text).toContain('SIL OPEN FONT LICENSE');
  });

  it('логотип Foreca присутствует и является PNG с прозрачностью', () => {
    const png = readAsset('assets/logo/foreca-wrc.png');
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // ширина и высота лежат в IHDR сразу после сигнатуры и длины блока
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBeGreaterThan(height);
    expect(png[25]).toBe(6); // color type 6 = RGBA
  });
});

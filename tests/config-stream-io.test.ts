import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { WizardCancelledError, createStreamIo } from '../src/config/wizard.js';

function make(): {
  io: ReturnType<typeof createStreamIo>;
  input: PassThrough;
  output: () => string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  // exec-режим PassThrough отдаёт данные только при наличии читателя.
  return { io: createStreamIo(input, output), input, output: () => text };
}

describe('createStreamIo', () => {
  it('отдаёт строки по очереди', async () => {
    const { io, input } = make();

    const first = io.ask('Токен: ');
    input.write('значение-1\n');
    await expect(first).resolves.toBe('значение-1');

    const second = io.ask('Город: ');
    input.write('город-2\n');
    await expect(second).resolves.toBe('город-2');
  });

  it('обрабатывает несколько строк из одного чанка', async () => {
    const { io, input } = make();

    const first = io.ask('1: ');
    const second = io.ask('2: ');
    input.write('два\r\nтри\n');

    await expect(first).resolves.toBe('два');
    await expect(second).resolves.toBe('три');
  });

  it('отдаёт последнюю строку без перевода строки при закрытии потока', async () => {
    const { io, input } = make();

    const answer = io.ask('Токен: ');
    input.write('без-перевода');
    input.end();

    await expect(answer).resolves.toBe('без-перевода');
  });

  it('прерывает ожидание, если поток закрылся без ответа', async () => {
    const { io, input } = make();

    const answer = io.ask('Токен: ');
    input.end();

    await expect(answer).rejects.toBeInstanceOf(WizardCancelledError);
  });

  it('не ждёт ответа после закрытия потока', async () => {
    const { io, input } = make();
    input.end();

    await expect(io.ask('Токен: ')).rejects.toBeInstanceOf(WizardCancelledError);
  });

  it('пишет вопрос в вывод', async () => {
    const { io, input, output } = make();

    const answer = io.ask('Вопрос: ');
    expect(output()).toContain('Вопрос: ');
    input.write('ok\n');
    await answer;
  });

  it('write добавляет перевод строки', () => {
    const { io, output } = make();
    io.write('сообщение');
    expect(output()).toBe('сообщение\n');
  });
});

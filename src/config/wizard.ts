/**
 * Интерактивный мастер настройки.
 *
 * Порядок важен: сначала токен, потом поиск локации. Токен проверяется реальным
 * запросом до сохранения — иначе неверный токен обнаружится только через полчаса,
 * при первом плановом обновлении.
 *
 * Ввод-вывод и фабрика клиента передаются снаружи: мастер тестируется без
 * реального терминала и без сети.
 */
import { StringDecoder } from 'node:string_decoder';

import type { ForecaClient, LocationInfo } from '../foreca/client.js';
import { isForecaError } from '../foreca/errors.js';
import { apiConfigSchema, stateConfigSchema, streamConfigSchema } from './schema.js';
import type { LocationConfig, ServiceConfig } from './schema.js';

export interface WizardIo {
  /** Печатает строку. */
  readonly write: (text: string) => void;
  /** Задаёт вопрос и возвращает ответ без завершающего перевода строки. */
  readonly ask: (question: string) => Promise<string>;
  /** Вопрос с маскированным вводом: для токена. */
  readonly askSecret?: (question: string) => Promise<string>;
}

export interface WizardOptions {
  /** Клиент по токену: позволяет проверить токен до сохранения. */
  readonly createClient: (token: string) => ForecaClient;
  readonly io: WizardIo;
  readonly maxAttempts?: number;
  readonly previousLocation?: LocationConfig | undefined;
}

export type WizardResult =
  | { readonly ok: true; readonly config: ServiceConfig }
  | { readonly ok: false; readonly reason: 'token' | 'location' };

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runWizard(options: WizardOptions): Promise<WizardResult> {
  const { io } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  io.write('Настройка foreca-cctv');
  io.write('Нужен токен Foreca Weather API и город для прогноза.');
  io.write('');

  const verified = await resolveToken(options, maxAttempts);
  if (verified === undefined) {
    return { ok: false, reason: 'token' };
  }

  const location = await resolveLocation(verified.client, options, maxAttempts);
  if (location === undefined) {
    return { ok: false, reason: 'location' };
  }

  return {
    ok: true,
    config: {
      forecaToken: verified.token,
      location,
      stream: streamConfigSchema.parse({}),
      api: apiConfigSchema.parse({}),
      state: stateConfigSchema.parse({}),
    },
  };
}

interface VerifiedToken {
  readonly token: string;
  readonly client: ForecaClient;
}

/**
 * Проверка токена: поиск заведомо существующего города требует авторизации.
 * Ошибка `auth` означает неверный токен, `quota` — исчерпанный тариф.
 */
async function resolveToken(
  options: WizardOptions,
  maxAttempts: number,
): Promise<VerifiedToken | undefined> {
  const { io, createClient } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const answer =
      io.askSecret === undefined
        ? await io.ask('Токен Foreca: ')
        : await io.askSecret('Токен Foreca: ');

    const token = answer.trim();
    if (token.length === 0) {
      io.write('Токен не может быть пустым.');
      continue;
    }

    let client: ForecaClient;
    try {
      client = createClient(token);
    } catch (error) {
      // Клиент отвергает токен ещё до запроса: недопустимые символы.
      io.write(describeError(error));
      continue;
    }

    try {
      await client.searchLocations('London');
      return { token, client };
    } catch (error) {
      if (isForecaError(error) && error.kind === 'auth') {
        io.write(`Foreca отклонила токен (попытка ${attempt} из ${maxAttempts}).`);
        continue;
      }
      if (isForecaError(error) && error.kind === 'quota') {
        io.write('Квота запросов исчерпана: проверьте тариф перед настройкой.');
        return undefined;
      }
      if (isForecaError(error) && error.kind === 'schema') {
        // Токен тут ни при чём: ответ пришёл, но не разобрался. Это дефект
        // сервиса, а не пользователя, поэтому не предлагаем «повторить ввод».
        io.write('Ответ Foreca не удалось разобрать. Это дефект сервиса, а не токена.');
        io.write('Сообщите разработчику: проверка схемы ответа не прошла.');
        return undefined;
      }
      if (isForecaError(error) && (error.kind === 'timeout' || error.kind === 'network')) {
        // Сеть действительно недоступна: повтор имеет смысл.
        io.write(`Не удалось проверить токен: ${describeError(error)}`);
        io.write('Проверьте сеть и повторите.');
        continue;
      }
      io.write(`Не удалось проверить токен: ${describeError(error)}`);
      continue;
    }
  }

  io.write('Попытки ввода токена закончились.');
  return undefined;
}

async function resolveLocation(
  client: ForecaClient,
  options: WizardOptions,
  maxAttempts: number,
): Promise<LocationConfig | undefined> {
  const { io } = options;
  const hint =
    options.previousLocation === undefined ? '' : ` (сейчас: ${options.previousLocation.name})`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const query = (await io.ask(`Город${hint}: `)).trim();
    if (query.length === 0) {
      io.write('Название города не может быть пустым.');
      continue;
    }

    let found: LocationInfo[];
    try {
      found = await client.searchLocations(query);
    } catch (error) {
      io.write(`Поиск не удался: ${describeError(error)}`);
      continue;
    }

    if (found.length === 0) {
      io.write('Ничего не нашлось. Попробуйте другое название.');
      continue;
    }

    const chosen = await chooseLocation(io, found);
    if (chosen === undefined) continue;

    const config = toLocationConfig(chosen);
    io.write(`Выбрано: ${describeLocation(chosen)}`);
    return config;
  }

  return undefined;
}

async function chooseLocation(
  io: WizardIo,
  candidates: readonly LocationInfo[],
): Promise<LocationInfo | undefined> {
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    io.write(`Найдено: ${describeLocation(only)}`);
    const confirm = (await io.ask('Подходит? [Д/н]: ')).trim().toLowerCase();
    const yes = confirm === '' || confirm === 'д' || confirm === 'да' || confirm === 'y';
    return yes ? only : undefined;
  }

  io.write('Найдено несколько вариантов:');
  candidates.forEach((candidate, index) => {
    io.write(`  ${index + 1}. ${describeLocation(candidate)}`);
  });

  const answer = (
    await io.ask(`Выберите номер (1-${candidates.length}) или оставьте пустым для отмены: `)
  ).trim();
  if (answer.length === 0) return undefined;

  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
    io.write('Не понял выбор. Попробуйте ещё раз.');
    return undefined;
  }
  return candidates[index];
}

export function describeLocation(location: LocationInfo): string {
  const parts = [location.name];
  if (location.adminArea !== undefined) parts.push(location.adminArea);
  if (location.country !== undefined) parts.push(location.country);
  if (location.timezone !== undefined) parts.push(`(${location.timezone})`);
  return parts.join(', ');
}

/** Координаты обязательны для рендера и запросов: без них настройка не имеет смысла. */
export function toLocationConfig(location: LocationInfo): LocationConfig {
  if (location.lon === undefined || location.lat === undefined) {
    throw new Error(`Foreca не вернула координаты для локации ${location.name}`);
  }
  return {
    name: location.name,
    lon: location.lon,
    lat: location.lat,
    ...(location.id === undefined ? {} : { id: location.id }),
    ...(location.country === undefined ? {} : { country: location.country }),
    ...(location.timezone === undefined ? {} : { timezone: location.timezone }),
  };
}

/**
 * Построчный ввод из потока. Отдельная функция, чтобы мастер не зависел
 * от `node:readline` и мог быть протестирован на строках.
 *
 * Конец потока считается отменой: если stdin закрылся, ждать строку бессмысленно,
 * и незавершённый Promise подвесил бы весь сервис.
 */
export function createStreamIo(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): WizardIo {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let closed = false;
  const pending: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];

  input.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      pending.shift()?.resolve(line);
    }
  });

  const onEnd = (): void => {
    closed = true;
    // Необработанный хвост без перевода строки считаем последним ответом.
    const tail = buffer.trim();
    buffer = '';
    if (tail.length > 0) {
      pending.shift()?.resolve(tail);
    }
    while (pending.length > 0) {
      pending.shift()?.reject(new WizardCancelledError());
    }
  };

  input.on('end', onEnd);
  input.on('close', onEnd);

  const ask = (question: string): Promise<string> => {
    if (closed) {
      return Promise.reject(new WizardCancelledError());
    }
    output.write(question);
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };

  return {
    write: (text) => {
      output.write(`${text}\n`);
    },
    ask,
  };
}

/** Ввод прерван: поток закрылся, не дав ответа. */
export class WizardCancelledError extends Error {
  constructor() {
    super('Ввод прерван: поток закрылся');
    this.name = 'WizardCancelledError';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

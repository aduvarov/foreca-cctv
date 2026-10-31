/**
 * Создание конфигурации без вопросов: из аргументов и окружения.
 *
 * Используется в контейнере, где терминала нет. Токен проверяется реальным
 * запросом, чтобы неверные параметры не превратились в конфиг, который
 * обнаружится через полчаса.
 */
import type { ForecaClient, LocationInfo } from '../foreca/client.js';
import { isForecaError } from '../foreca/errors.js';
import { apiConfigSchema, stateConfigSchema, streamConfigSchema } from './schema.js';
import type { ServiceConfig } from './schema.js';
import { toLocationConfig } from './wizard.js';

export interface BootstrapOptions {
  readonly createClient: (token: string) => ForecaClient;
  readonly token: string;
  readonly locationQuery: string;
}

export type BootstrapResult =
  | { readonly ok: true; readonly config: ServiceConfig; readonly location: LocationInfo }
  | { readonly ok: false; readonly message: string };

export async function bootstrapConfig(options: BootstrapOptions): Promise<BootstrapResult> {
  const token = options.token.trim();
  if (token.length === 0) {
    return { ok: false, message: 'Токен Foreca пуст' };
  }

  const query = options.locationQuery.trim();
  if (query.length === 0) {
    return { ok: false, message: 'Локация не задана' };
  }

  let client: ForecaClient;
  try {
    client = options.createClient(token);
  } catch (error) {
    // Клиент отвергает токен до запроса: сообщаем причину, а не «проверьте сеть».
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let found: LocationInfo[];
  try {
    found = await client.searchLocations(query);
  } catch (error) {
    if (isForecaError(error) && error.kind === 'auth') {
      return { ok: false, message: 'Foreca отклонила токен: проверьте FORECA_TOKEN' };
    }
    if (isForecaError(error) && error.kind === 'quota') {
      return { ok: false, message: 'Квота запросов Foreca исчерпана' };
    }
    return {
      ok: false,
      message: `Не удалось проверить параметры: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (found.length === 0) {
    return { ok: false, message: `Локация «${query}» не найдена` };
  }

  const first = found[0];
  if (first === undefined) {
    return { ok: false, message: `Локация «${query}» не найдена` };
  }

  // В неинтерактивном режиме выбирать некому: берём первый результат и сообщаем,
  // если вариантов несколько — пользователь увидит это в журнале.
  const config: ServiceConfig = {
    forecaToken: token,
    location: toLocationConfig(first),
    stream: streamConfigSchema.parse({}),
    api: apiConfigSchema.parse({}),
    state: stateConfigSchema.parse({}),
  };

  return { ok: true, config, location: first };
}

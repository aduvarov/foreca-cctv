/**
 * Категории отказов при обращении к Foreca.
 *
 * Разделение важно не для красоты: от категории зависит, что делать дальше.
 * Ошибку авторизации бессмысленно ретраить, ограничение частоты надо уважать
 * через `Retry-After`, а сетевой сбой — повторять с нарастающей задержкой.
 */
export type ForecaErrorKind =
  'auth' | 'quota' | 'rate-limit' | 'timeout' | 'network' | 'http' | 'schema' | 'cancelled';

export interface ForecaErrorOptions {
  readonly kind: ForecaErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ForecaError extends Error {
  readonly kind: ForecaErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: ForecaErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ForecaError';
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Ошибки, которые имеет смысл повторять. */
  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'rate-limit';
  }
}

export function isForecaError(error: unknown): error is ForecaError {
  return error instanceof ForecaError;
}

export function authError(status: number): ForecaError {
  return new ForecaError({
    kind: 'auth',
    status,
    message: 'Foreca отклонила токен (ошибка авторизации)',
  });
}

export function quotaError(status: number): ForecaError {
  return new ForecaError({
    kind: 'quota',
    status,
    message: 'Квота запросов Foreca исчерпана',
  });
}

export function rateLimitError(status: number, retryAfterMs: number | undefined): ForecaError {
  const options: ForecaErrorOptions = {
    kind: 'rate-limit',
    status,
    message: 'Foreca ограничила частоту запросов',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  return new ForecaError(options);
}

export function timeoutError(timeoutMs: number, cause?: unknown): ForecaError {
  return new ForecaError({
    kind: 'timeout',
    message: `Запрос к Foreca не уложился в ${timeoutMs} мс`,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function networkError(cause: unknown): ForecaError {
  return new ForecaError({
    kind: 'network',
    message: 'Сетевая ошибка при обращении к Foreca',
    cause,
  });
}

export function httpError(status: number, statusText: string): ForecaError {
  return new ForecaError({
    kind: 'http',
    status,
    message: `Foreca ответила ${status} ${statusText}`.trim(),
  });
}

export function schemaError(details: string): ForecaError {
  return new ForecaError({
    kind: 'schema',
    message: `Ответ Foreca не соответствует схеме: ${details}`,
  });
}

export function cancelledError(cause?: unknown): ForecaError {
  return new ForecaError({
    kind: 'cancelled',
    message: 'Запрос к Foreca отменён',
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Разбирает `Retry-After`: допускается и число секунд, и HTTP-дата.
 * Возвращает `undefined`, если заголовок отсутствует или нечитаем.
 */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

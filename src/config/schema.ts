/**
 * Схема конфигурации сервиса.
 *
 * Конфигурация валидируется zod: файл мог быть отредактирован вручную, и сервис
 * не должен начинать вещание с частично прочитанными настройками. Все
 * необязательные для пользователя параметры имеют значения по умолчанию, поэтому
 * мастеру достаточно спросить токен и локацию.
 */
import { z } from 'zod';

/** Локация в конфигурации: координаты обязательны, остальное — подсказки. */
export const locationConfigSchema = z.object({
  name: z.string().min(1, 'Название локации не может быть пустым'),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  id: z.number().int().positive().optional(),
  country: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});

export const streamConfigSchema = z.object({
  fps: z.number().int().min(1).max(30).default(1),
  bitrateKbps: z.number().int().min(100).max(8_000).default(400),
  width: z.number().int().positive().default(704),
  height: z.number().int().positive().default(576),
  rtspUrl: z
    .string()
    .regex(/^rtsps?:\/\//, 'Адрес публикации должен начинаться с rtsp:// или rtsps://')
    .default('rtsp://127.0.0.1:8554/weather'),
});

export const apiConfigSchema = z.object({
  baseUrl: z.url().default('https://weatherapi.foreca.net'),
  refreshMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(10_000),
  staleAfterMinutes: z
    .number()
    .int()
    .min(10)
    .max(24 * 60)
    .default(90),
});

export const stateConfigSchema = z.object({
  cacheDir: z.string().min(1).default('./state'),
  /** Порт локального сервера состояния и снимка. */
  healthPort: z.number().int().min(0).max(65_535).default(9_970),
  healthHost: z.string().min(1).default('127.0.0.1'),
});

export const configSchema = z.object({
  forecaToken: z.string().min(1, 'Токен Foreca не может быть пустым'),
  location: locationConfigSchema,
  // prefault применяет значения по умолчанию до разбора, поэтому пустой объект
  // допустим: каждое поле внутри уже имеет свой default.
  stream: streamConfigSchema.prefault({}),
  api: apiConfigSchema.prefault({}),
  state: stateConfigSchema.prefault({}),
});

export type ServiceConfig = z.infer<typeof configSchema>;
export type LocationConfig = z.infer<typeof locationConfigSchema>;
export type StreamConfig = z.infer<typeof streamConfigSchema>;
export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type StateConfig = z.infer<typeof stateConfigSchema>;

export type ParseResult =
  | { readonly ok: true; readonly config: ServiceConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Разбирает значение из файла и собирает человекочитаемый список проблем. */
export function parseConfig(raw: unknown): ParseResult {
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }

  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
  return { ok: false, problems };
}

/** Конфигурация по умолчанию для примера в репозитории. */
export function exampleConfig(): ServiceConfig {
  return {
    forecaToken: 'ЗАМЕНИТЕ_НА_СВОЙ_ТОКЕН',
    location: {
      name: 'Караганда',
      lat: 49.8047,
      lon: 73.1094,
      timezone: 'Asia/Almaty',
    },
    stream: streamConfigSchema.parse({}),
    api: apiConfigSchema.parse({}),
    state: stateConfigSchema.parse({}),
  };
}

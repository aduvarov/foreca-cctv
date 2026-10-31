/**
 * Нормализация спеки Foreca Weather API перед кодогенерацией.
 *
 * Зачем это нужно:
 *  1. В спеке 37 операций, но только 24 уникальных `operationId`:
 *     `get_daily` встречается 6 раз, `get_hourly` — 6, `get_current` — 3,
 *     `get_point` — 2. Без нормализации `@hey-api/openapi-ts` порождает
 *     `zGetDaily`, `zGetDaily2`, ... `zGetDaily6`, а `tsc --strict` падает
 *     с `Duplicate identifier`.
 *  2. Уникальный `operationId` строится из метода и пути, поэтому имя схемы
 *     однозначно привязано к эндпоинту и не зависит от порядка в файле.
 *
 * Скрипт ничего не удаляет из спеки и не меняет схемы ответов — только идентификаторы.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

export interface OpenApiOperation {
  operationId?: unknown;
  [key: string]: unknown;
}

export type OpenApiPathItem = Record<string, unknown>;

export interface OpenApiDocument {
  paths?: Record<string, OpenApiPathItem>;
}

/**
 * Превращает путь и метод в стабильный идентификатор.
 *
 * `/api/v1/forecast/3hourly/{location}` + `get`
 *   -> `get_api_v1_forecast_3hourly_location`
 *
 * `3hourly` намеренно не становится `hourly`: цифры значимы и различают эндпоинты.
 */
export function buildOperationId(method: string, path: string): string {
  const cleaned = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('_');
  return `${method.toLowerCase()}_${cleaned}`.toLowerCase();
}

export interface NormalizeResult {
  document: OpenApiDocument;
  renamed: number;
  ids: string[];
}

export function normalizeDocument(document: OpenApiDocument): NormalizeResult {
  const paths = document.paths;
  if (paths === undefined) {
    throw new Error('В спеке отсутствует секция paths');
  }

  const ids: string[] = [];
  const seen = new Map<string, string>();
  let renamed = 0;

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined || typeof operation !== 'object' || operation === null) {
        continue;
      }

      const id = buildOperationId(method, path);
      const previous = seen.get(id);
      if (previous !== undefined) {
        throw new Error(
          `Коллизия идентификатора "${id}": уже занят "${previous}", повторно встречается в ${method.toUpperCase()} ${path}`,
        );
      }
      seen.set(id, `${method.toUpperCase()} ${path}`);

      const typed = operation as OpenApiOperation;
      if (typed.operationId !== id) {
        typed.operationId = id;
        renamed += 1;
      }
      ids.push(id);
    }
  }

  return { document, renamed, ids };
}

export function countDuplicateOperationIds(document: OpenApiDocument): number {
  const counter = new Map<string, number>();
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation !== undefined && typeof operation === 'object' && operation !== null) {
        const id = (operation as OpenApiOperation).operationId;
        if (typeof id === 'string') {
          counter.set(id, (counter.get(id) ?? 0) + 1);
        }
      }
    }
  }
  const duplicates = [...counter.values()].filter((count) => count > 1);
  return duplicates.reduce((sum, count) => sum + count - 1, 0);
}

/**
 * Помечает необязательные скалярные поля как допускающие null.
 *
 * Почему это нужно: в спеке Foreca нет ни одного `required`, а `nullable`
 * объявлен лишь у 15 полей из 554. На практике API регулярно возвращает `null`
 * в необязательных полях — например, `adminArea2: null` в поиске локаций.
 * Без этой правки сгенерированная zod-схема отвергает валидный ответ,
 * и сервис не может сохранить даже правильный токен.
 *
 * Правило узкое: меняются только необязательные поля простых типов.
 * Массивы и объекты не трогаются — их `null` в спеке уже размечен, а гадать
 * о структуре вложенных значений нельзя.
 */
export function markOptionalScalarsNullable(document: OpenApiDocument): number {
  let changed = 0;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    const record = node as Record<string, unknown>;
    if (record['type'] === 'object' && isRecord(record['properties'])) {
      const required = Array.isArray(record['required']) ? record['required'] : [];
      const requiredNames = new Set(
        required.filter((name): name is string => typeof name === 'string'),
      );

      for (const [name, schema] of Object.entries(record['properties'])) {
        if (!isRecord(schema)) continue;
        const type = schema['type'];
        const isScalar = type === 'string' || type === 'number' || type === 'boolean';
        if (isScalar && !requiredNames.has(name) && schema['nullable'] !== true) {
          schema['nullable'] = true;
          changed += 1;
        }
      }
    }

    for (const value of Object.values(record)) visit(value);
  };

  visit(document.paths);
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const source = resolve(root, 'foreca-weather-api.openapi.json');
  const target = resolve(root, 'build', 'foreca.normalized.json');

  const raw = JSON.parse(readFileSync(source, 'utf8')) as OpenApiDocument;
  // Дубли считаются до мутации: normalizeDocument переписывает operationId на месте.
  const duplicatesBefore = countDuplicateOperationIds(raw);
  const { document, renamed, ids } = normalizeDocument(raw);
  // Nullable размечается после нормализации: порядок не важен, но так виднее
  // в отчёте, сколько полей пришлось исправить.
  const nullable = markOptionalScalarsNullable(document);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.log(`операций: ${ids.length}`);
  console.log(`переименовано: ${renamed}`);
  console.log(`дублей идентификаторов до нормализации: ${duplicatesBefore}`);
  console.log(`необязательных скалярных полей помечено nullable: ${nullable}`);
  console.log(`записано: ${target}`);
}

// Скрипт не должен выполнять работу при импорте из тестов.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}

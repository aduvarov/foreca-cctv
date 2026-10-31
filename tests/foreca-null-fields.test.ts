import { describe, expect, it } from 'vitest';

import {
  buildOperationId,
  markOptionalScalarsNullable,
  normalizeDocument,
} from '../scripts/normalize-openapi.js';
import {
  zGetApiV1Forecast3HourlyLocationResponse,
  zGetApiV1LocationLocationResponse,
  zGetApiV1LocationSearchQueryResponse,
} from '../src/generated/zod.gen.js';
import { ForecaClient } from '../src/foreca/client.js';

/**
 * Регрессия: Foreca возвращает `null` в необязательных полях, а в спеке
 * `nullable` почти нигде не указан. Из-за этого сгенерированная схема
 * отвергала валидный ответ, и мастер настройки не мог сохранить даже
 * правильный токен — с сообщением «проверьте сеть».
 */

type TestSchema = {
  type?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, TestSchema>;
  items?: TestSchema;
};

type TestDocument = {
  paths: Record<string, Record<string, unknown>>;
};

/** Документ с одним ответом, чья схема — заданный объект. */
function documentWith(schema: TestSchema): TestDocument {
  return {
    paths: {
      '/x': {
        get: {
          responses: {
            200: { content: { 'application/json': { schema } } },
          },
        },
      },
    },
  };
}

/** Достаёт схему ответа из тестового документа. */
function schemaOf(document: TestDocument): TestSchema {
  const pathItem = document.paths['/x'];
  const operation = pathItem?.['get'] as
    { responses: Record<number, { content: Record<string, { schema: TestSchema }> }> } | undefined;
  return operation?.responses[200]?.content['application/json']?.schema ?? {};
}

describe('markOptionalScalarsNullable', () => {
  it('помечает необязательные скалярные поля как nullable', () => {
    const document = documentWith({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
        flag: { type: 'boolean' },
      },
    });

    expect(markOptionalScalarsNullable(document)).toBe(3);

    const properties = schemaOf(document).properties;
    expect(properties?.['name']?.nullable).toBe(true);
    expect(properties?.['count']?.nullable).toBe(true);
    expect(properties?.['flag']?.nullable).toBe(true);
  });

  it('не трогает обязательные поля', () => {
    const document = documentWith({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'number' } },
    });

    expect(markOptionalScalarsNullable(document)).toBe(0);
    expect(schemaOf(document).properties?.['id']?.nullable).toBeUndefined();
  });

  it('не трогает массивы и объекты', () => {
    const document = documentWith({
      type: 'object',
      properties: {
        items: { type: 'array' },
        nested: { type: 'object' },
      },
    });

    expect(markOptionalScalarsNullable(document)).toBe(0);
  });

  it('не перезаписывает уже помеченные nullable', () => {
    const document = documentWith({
      type: 'object',
      properties: { name: { type: 'string', nullable: true } },
    });

    expect(markOptionalScalarsNullable(document)).toBe(0);
  });

  it('заходит во вложенные объекты и элементы массивов', () => {
    const document = documentWith({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: { inner: { type: 'string' } },
          },
        },
      },
    });

    expect(markOptionalScalarsNullable(document)).toBe(1);
  });
});

describe('регрессия: null в реальном ответе Foreca', () => {
  it('схема поиска локаций принимает adminArea2: null', () => {
    // Именно этот ответ вернул API и сломал мастер настройки.
    const response = {
      locations: [
        {
          id: 100184745,
          name: 'Караганда',
          country: 'Казахстан',
          timezone: 'Asia/Almaty',
          language: 'ru',
          adminArea: 'Карагандинская область',
          adminArea2: null,
          adminArea3: null,
          lon: 73.1094,
          lat: 49.8047,
        },
      ],
    };

    expect(() => zGetApiV1LocationSearchQueryResponse.parse(response)).not.toThrow();
  });

  it('схема метаданных локации принимает null в необязательных полях', () => {
    const response = {
      id: 1,
      name: 'Караганда',
      country: null,
      timezone: null,
      language: null,
      adminArea: null,
      adminArea2: null,
      adminArea3: null,
      lon: 73.1094,
      lat: 49.8047,
    };

    expect(() => zGetApiV1LocationLocationResponse.parse(response)).not.toThrow();
  });

  it('схема прогноза принимает null в шаге', () => {
    const response = {
      forecast: [
        {
          time: '2026-11-01T00:00:00+05:00',
          temperature: 4.2,
          symbol: null,
          symbolPhrase: null,
          precipAccum: null,
          windDir: null,
          windSpeed: null,
          cloudiness: null,
        },
      ],
    };

    expect(() => zGetApiV1Forecast3HourlyLocationResponse.parse(response)).not.toThrow();
  });

  it('клиент превращает null в undefined, а не пробрасывает наружу', async () => {
    const http = {
      async request() {
        return new Response(
          JSON.stringify({
            locations: [
              {
                id: 1,
                name: 'Караганда',
                country: null,
                timezone: null,
                adminArea: null,
                adminArea2: null,
                adminArea3: null,
                lon: 73.1094,
                lat: 49.8047,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    };
    const client = new ForecaClient({ token: 'token-value', http });

    const found = await client.searchLocations('Караганда');

    expect(found).toHaveLength(1);
    // null не должен доходить до потребителей: они проверяют undefined.
    expect(found[0]?.country).toBeUndefined();
    expect(found[0]?.timezone).toBeUndefined();
    expect(found[0]?.adminArea).toBeUndefined();
    expect(found[0]?.lon).toBe(73.1094);
  });

  it('клиент превращает null в шаге прогноза в undefined', async () => {
    const http = {
      async request() {
        return new Response(
          JSON.stringify({
            forecast: [{ time: '2026-11-01T00:00:00+05:00', temperature: 4.2, symbol: null }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    };
    const client = new ForecaClient({ token: 'token-value', http });

    const forecast = await client.getThreeHourlyForecast('1,2');

    expect(forecast.steps[0]?.symbol).toBeUndefined();
    expect(forecast.steps[0]?.temperature).toBe(4.2);
  });
});

describe('спек не сломан нормализацией', () => {
  it('идентификатор операции строится из метода и пути', () => {
    expect(buildOperationId('get', '/api/v1/location/search/{query}')).toBe(
      'get_api_v1_location_search_query',
    );
  });

  it('нормализация не теряет операции', () => {
    const document = {
      paths: {
        '/a': { get: { operationId: 'x' } },
        '/b': { get: { operationId: 'y' }, post: { operationId: 'z' } },
      },
    };

    const result = normalizeDocument(document);
    expect(result.ids).toHaveLength(3);
  });
});

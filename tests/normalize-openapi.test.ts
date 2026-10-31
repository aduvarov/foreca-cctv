import { describe, expect, it } from 'vitest';
import { buildOperationId, normalizeDocument } from '../scripts/normalize-openapi.js';

interface MinimalOperation {
  operationId?: string;
}

interface MinimalDocument {
  paths: Record<string, Record<string, MinimalOperation>>;
}

describe('buildOperationId', () => {
  it('строит идентификатор из метода и пути', () => {
    expect(buildOperationId('get', '/api/v1/forecast/3hourly/{location}')).toBe(
      'get_api_v1_forecast_3hourly_location',
    );
  });

  it('сохраняет значимые цифры в сегменте пути', () => {
    expect(buildOperationId('get', '/api/v1/forecast/15minutely/{location}')).toBe(
      'get_api_v1_forecast_15minutely_location',
    );
    expect(buildOperationId('get', '/api/v1/forecast/3hourly/{location}')).not.toBe(
      buildOperationId('get', '/api/v1/forecast/hourly/{location}'),
    );
  });

  it('различает методы на одном пути', () => {
    expect(buildOperationId('get', '/authorize/key')).not.toBe(
      buildOperationId('post', '/authorize/key'),
    );
  });

  it('убирает фигурные скобки параметров пути', () => {
    expect(buildOperationId('get', '/api/v1/image/tile/{z}/{x}/{y}/{time}/{id}')).toBe(
      'get_api_v1_image_tile_z_x_y_time_id',
    );
  });
});

describe('normalizeDocument', () => {
  it('переписывает неуникальные идентификаторы', () => {
    const document: MinimalDocument = {
      paths: {
        '/api/v1/forecast/daily/{location}': { get: { operationId: 'get_daily' } },
        '/api/v1/pollen/forecast/daily/{location}': { get: { operationId: 'get_daily' } },
      },
    };

    const result = normalizeDocument(document);

    expect(result.ids).toEqual([
      'get_api_v1_forecast_daily_location',
      'get_api_v1_pollen_forecast_daily_location',
    ]);
    expect(result.renamed).toBe(2);
  });

  it('не считает переименованием уже правильный идентификатор', () => {
    const document: MinimalDocument = {
      paths: {
        '/api/v1/forecast/daily/{location}': {
          get: { operationId: 'get_api_v1_forecast_daily_location' },
        },
      },
    };

    expect(normalizeDocument(document).renamed).toBe(0);
  });

  it('падает при коллизии разных путей вместо перезаписи', () => {
    // `/a_b` и `/a/b` дают одинаковый идентификатор: это должна быть ошибка,
    // иначе одна операция молча затрёт другую.
    const document: MinimalDocument = {
      paths: {
        '/a_b': { get: { operationId: 'one' } },
        '/a/b': { get: { operationId: 'two' } },
      },
    };

    expect(() => normalizeDocument(document)).toThrow(/Коллизия/);
  });

  it('падает, если секции paths нет', () => {
    expect(() => normalizeDocument({})).toThrow(/paths/);
  });
});

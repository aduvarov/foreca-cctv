import { describe, expect, it } from 'vitest';
import {
  zGetApiV1Forecast3HourlyLocationResponse,
  zGetApiV1LocationLocationResponse,
  zGetApiV1LocationSearchQueryResponse,
} from '../src/generated/zod.gen.js';
import {
  emptyThreeHourlyResponse,
  locationResponse,
  locationSearchResponse,
  threeHourlyResponse,
} from './fixtures/foreca.js';

describe('сгенерированные zod-схемы Foreca', () => {
  it('схема ответа 3-hourly названа по пути, а не по порядковому номеру', () => {
    expect(typeof zGetApiV1Forecast3HourlyLocationResponse.parse).toBe('function');
    // Раньше при дублях operationId появлялись zGetHourly, zGetHourly2, ... —
    // такие имена не привязаны к эндпоинту и их легко перепутать.
    expect('zGetHourly' in globalThis).toBe(false);
  });

  it('принимает реальную форму ответа прогноза', () => {
    const parsed = zGetApiV1Forecast3HourlyLocationResponse.parse(threeHourlyResponse);
    expect(parsed.forecast).toHaveLength(64);
    const first = parsed.forecast?.[0];
    expect(first?.time).toBeTruthy();
    expect(typeof first?.temperature).toBe('number');
    expect(first?.symbol).toMatch(/^[dn]\d{3}$/);
  });

  it('принимает пустой список шагов (это не ошибка схемы)', () => {
    const parsed = zGetApiV1Forecast3HourlyLocationResponse.parse(emptyThreeHourlyResponse);
    expect(parsed.forecast).toEqual([]);
  });

  it('отклоняет тело, где forecast не массив', () => {
    expect(() => zGetApiV1Forecast3HourlyLocationResponse.parse({ forecast: 'нет' })).toThrow();
  });

  it('отклоняет тело, где у шага неверный тип температуры', () => {
    expect(() =>
      zGetApiV1Forecast3HourlyLocationResponse.parse({
        forecast: [{ time: '2026-11-01T00:00:00+05:00', temperature: 'тепло' }],
      }),
    ).toThrow();
  });

  it('все поля необязательные, потому что в спеке нет required', () => {
    // Это фиксирует реальное свойство спеки Foreca: пустой ответ проходит схему,
    // поэтому полноту данных обязан проверять доменный слой, а не валидатор.
    const parsed = zGetApiV1Forecast3HourlyLocationResponse.parse({});
    expect(parsed).toEqual({});
  });

  it('принимает ответ метаданных локации', () => {
    const parsed = zGetApiV1LocationLocationResponse.parse(locationResponse);
    expect(parsed.name).toBe('Караганда');
    expect(parsed.timezone).toBe('Asia/Almaty');
  });

  it('принимает результат поиска локации', () => {
    const parsed = zGetApiV1LocationSearchQueryResponse.parse(locationSearchResponse);
    expect(parsed.locations).toHaveLength(2);
    expect(parsed.locations?.map((item) => item.country)).toEqual(['Казахстан', 'Россия']);
  });
});

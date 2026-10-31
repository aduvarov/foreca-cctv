import { describe, expect, it, vi } from 'vitest';

import type { ForecaClient, LocationInfo } from '../src/foreca/client.js';
import { authError, networkError, quotaError } from '../src/foreca/errors.js';
import { describeLocation, runWizard, toLocationConfig } from '../src/config/wizard.js';
import type { WizardIo } from '../src/config/wizard.js';

const karaganda: LocationInfo = {
  id: 100184745,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: 'Asia/Almaty',
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

const karagandaRu: LocationInfo = {
  id: 100184746,
  name: 'Караганда',
  country: 'Россия',
  timezone: 'Asia/Yekaterinburg',
  adminArea: 'Челябинская область',
  lon: 60.1,
  lat: 55.2,
};

/** Ответы выдаются по очереди, каждый вызов `ask` забирает следующий. */
function scriptedIo(answers: readonly string[]): { io: WizardIo; output: string[] } {
  const output: string[] = [];
  let index = 0;
  return {
    output,
    io: {
      write: (text) => output.push(text),
      ask: () => {
        const answer = answers[index];
        index += 1;
        return Promise.resolve(answer ?? '');
      },
    },
  };
}

function fakeClient(behaviour: {
  search?: (query: string) => Promise<LocationInfo[]>;
}): ForecaClient {
  return {
    searchLocations: behaviour.search ?? (() => Promise.resolve([karaganda])),
  } as unknown as ForecaClient;
}

describe('runWizard', () => {
  it('настраивает одну найденную локацию после подтверждения', async () => {
    const { io, output } = scriptedIo(['хороший-токен', 'Караганда', '']);
    const createClient = vi.fn(() => fakeClient({}));

    const result = await runWizard({ createClient, io });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.forecaToken).toBe('хороший-токен');
    expect(result.config.location).toEqual({
      name: 'Караганда',
      lon: 73.1094,
      lat: 49.8047,
      id: 100184745,
      country: 'Казахстан',
      timezone: 'Asia/Almaty',
    });
    expect(output.join('\n')).toContain('Найдено: Караганда');
  });

  it('переспрашивает токен, если Foreca его отклонила', async () => {
    let calls = 0;
    const createClient = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return fakeClient({
          search: () => Promise.reject(authError(401)),
        });
      }
      return fakeClient({});
    });
    const { io, output } = scriptedIo(['плохой-токен', 'хороший-токен', 'Караганда', '']);

    const result = await runWizard({ createClient, io });

    expect(result.ok).toBe(true);
    expect(output.join('\n')).toContain('отклонила токен');
  });

  it('сдаётся после исчерпания попыток ввода токена', async () => {
    const createClient = () => fakeClient({ search: () => Promise.reject(authError(401)) });
    const { io } = scriptedIo(['a', 'b', 'c']);

    const result = await runWizard({ createClient, io, maxAttempts: 3 });

    expect(result).toEqual({ ok: false, reason: 'token' });
  });

  it('не принимает пустой токен', async () => {
    const createClient = vi.fn(() => fakeClient({}));
    const { io, output } = scriptedIo(['   ', 'токен', 'Караганда', '']);

    const result = await runWizard({ createClient, io });

    expect(result.ok).toBe(true);
    expect(output.join('\n')).toContain('Токен не может быть пустым');
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('переспрашивает локацию, если ничего не нашлось', async () => {
    // Проверка токена тоже идёт через поиск, поэтому различаем по строке запроса.
    const createClient = () =>
      fakeClient({
        search: (query) => Promise.resolve(query === 'абракадабра' ? [] : [karaganda]),
      });
    const { io, output } = scriptedIo(['токен', 'абракадабра', 'Караганда', '']);

    const result = await runWizard({ createClient, io });

    expect(result.ok).toBe(true);
    expect(output.join('\n')).toContain('Ничего не нашлось');
  });

  it('требует выбрать вариант при неоднозначном поиске', async () => {
    const createClient = () =>
      fakeClient({
        search: (query) =>
          Promise.resolve(query === 'London' ? [karaganda] : [karaganda, karagandaRu]),
      });
    // Первый ответ — «2», значит выбираем российскую Караганду.
    const { io, output } = scriptedIo(['токен', 'Караганда', '2']);

    const result = await runWizard({ createClient, io });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.location.country).toBe('Россия');
    expect(output.join('\n')).toContain('Найдено несколько вариантов');
    expect(output.join('\n')).toContain('1. Караганда');
  });

  it('отклоняет несуществующий номер варианта', async () => {
    // Проверка токена ищет London и должна вернуть один вариант,
    // а Караганда — два, чтобы проверить выбор номера.
    const createClient = () =>
      fakeClient({
        search: (query) =>
          Promise.resolve(query === 'London' ? [karaganda] : [karaganda, karagandaRu]),
      });
    // 9 — неверный номер, затем повторный ввод города и корректный выбор «1».
    const { io, output } = scriptedIo(['токен', 'Караганда', '9', 'Караганда', '1']);

    const result = await runWizard({ createClient, io });

    expect(result.ok).toBe(true);
    expect(output.join('\n')).toContain('Не понял выбор');
  });

  it('не сохраняет локацию, если пользователь не подтвердил', async () => {
    const createClient = () => fakeClient({});
    const { io } = scriptedIo(['токен', 'Караганда', 'н', 'Караганда', 'н', 'Караганда', 'н']);

    const result = await runWizard({ createClient, io, maxAttempts: 3 });

    expect(result).toEqual({ ok: false, reason: 'location' });
  });

  it('не падает, если проверка токена невозможна из-за сети', async () => {
    let attempt = 0;
    const createClient = () => {
      attempt += 1;
      if (attempt === 1) {
        return fakeClient({ search: () => Promise.reject(networkError(new Error('нет сети'))) });
      }
      return fakeClient({});
    };
    const { io, output } = scriptedIo(['токен', 'токен2', 'Караганда', '']);

    const result = await runWizard({ createClient, io });

    // Сеть — не вина пользователя: мастер сообщает и даёт повторить.
    expect(output.join('\n')).toContain('Проверьте сеть');
    expect(result.ok).toBe(true);
  });

  it('отказывается продолжать при исчерпанной квоте', async () => {
    const createClient = () => fakeClient({ search: () => Promise.reject(quotaError(402)) });
    const { io, output } = scriptedIo(['токен']);

    const result = await runWizard({ createClient, io });

    expect(result).toEqual({ ok: false, reason: 'token' });
    expect(output.join('\n')).toContain('Квота');
  });
});

describe('toLocationConfig', () => {
  it('переносит координаты и подсказки', () => {
    expect(toLocationConfig(karaganda)).toEqual({
      name: 'Караганда',
      lon: 73.1094,
      lat: 49.8047,
      id: 100184745,
      country: 'Казахстан',
      timezone: 'Asia/Almaty',
    });
  });

  it('падает, если координат нет: без них прогноз не запросить', () => {
    expect(() => toLocationConfig({ ...karaganda, lon: undefined, lat: undefined })).toThrow(
      /координаты/,
    );
  });
});

describe('describeLocation', () => {
  it('показывает регион, страну и пояс', () => {
    expect(describeLocation(karaganda)).toBe(
      'Караганда, Карагандинская область, Казахстан, (Asia/Almaty)',
    );
  });

  it('не оставляет лишних запятых без дополнительных полей', () => {
    expect(
      describeLocation({
        id: undefined,
        name: 'Точка',
        country: undefined,
        timezone: undefined,
        adminArea: undefined,
        lon: 1,
        lat: 2,
      }),
    ).toBe('Точка');
  });
});

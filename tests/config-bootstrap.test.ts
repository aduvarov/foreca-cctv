import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { bootstrapConfig } from '../src/config/bootstrap.js';
import { parseConfig } from '../src/config/schema.js';
import type { ForecaClient, LocationInfo } from '../src/foreca/client.js';
import { authError, networkError, quotaError } from '../src/foreca/errors.js';

const karaganda: LocationInfo = {
  id: 100184745,
  name: 'Караганда',
  country: 'Казахстан',
  timezone: 'Asia/Almaty',
  adminArea: 'Карагандинская область',
  lon: 73.1094,
  lat: 49.8047,
};

function client(search: (query: string) => Promise<LocationInfo[]>): ForecaClient {
  return { searchLocations: search } as unknown as ForecaClient;
}

describe('bootstrapConfig', () => {
  it('создаёт конфигурацию из параметров окружения', async () => {
    const createClient = vi.fn(() => client(() => Promise.resolve([karaganda])));

    const result = await bootstrapConfig({
      createClient,
      token: '  токен-из-окружения  ',
      locationQuery: 'Караганда',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.forecaToken).toBe('токен-из-окружения');
    expect(result.config.location.name).toBe('Караганда');
    expect(result.config.location.timezone).toBe('Asia/Almaty');
  });

  it('сообщает о пустом токене без обращения к сети', async () => {
    const createClient = vi.fn();

    const result = await bootstrapConfig({
      createClient,
      token: '   ',
      locationQuery: 'Караганда',
    });

    expect(result.ok).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('сообщает о пустой локации без обращения к сети', async () => {
    const createClient = vi.fn();

    const result = await bootstrapConfig({
      createClient,
      token: 'токен',
      locationQuery: '',
    });

    expect(result.ok).toBe(false);
  });

  it('отдельно сообщает об отклонённом токене', async () => {
    const result = await bootstrapConfig({
      createClient: () => client(() => Promise.reject(authError(401))),
      token: 'плохой',
      locationQuery: 'Караганда',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('FORECA_TOKEN');
  });

  it('сообщает об исчерпанной квоте', async () => {
    const result = await bootstrapConfig({
      createClient: () => client(() => Promise.reject(quotaError(402))),
      token: 'токен',
      locationQuery: 'Караганда',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Квота');
  });

  it('сообщает о сетевой ошибке', async () => {
    const result = await bootstrapConfig({
      createClient: () => client(() => Promise.reject(networkError(new Error('нет сети')))),
      token: 'токен',
      locationQuery: 'Караганда',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Сетевая ошибка');
  });

  it('сообщает, если локация не найдена', async () => {
    const result = await bootstrapConfig({
      createClient: () => client(() => Promise.resolve([])),
      token: 'токен',
      locationQuery: 'абракадабра',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('не найдена');
  });
});

describe('config.example.json', () => {
  it('присутствует и проходит схему', () => {
    const raw = readFileSync(join(import.meta.dirname, '..', 'config.example.json'), 'utf8');
    const result = parseConfig(JSON.parse(raw));
    expect(result.ok).toBe(true);
  });

  it('не содержит настоящего токена', () => {
    const raw = readFileSync(join(import.meta.dirname, '..', 'config.example.json'), 'utf8');
    expect(raw).toContain('ВСТАВЬТЕ_ТОКЕН');
  });
});

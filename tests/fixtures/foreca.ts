/**
 * Сохранённый реальный ответ Foreca 3-hourly.
 *
 * Источник — примеры из `foreca-weather-api.openapi.json` плюс правдоподобные
 * значения для остальных полей. Нужен для тестов доменной сборки и для проверки,
 * что сгенерированная zod-схема принимает настоящую форму ответа.
 *
 * Структура повторяет ответ API: объект с единственным полем `forecast`,
 * внутри — массив шагов по 3 часа.
 */

const base = new Date('2026-11-01T00:00:00+05:00');

function step(index: number): Record<string, unknown> {
  const time = new Date(base.getTime() + index * 3 * 60 * 60 * 1000);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: 'Asia/Almaty',
    }).format(time),
  );
  const isNight = hour < 7 || hour >= 19;
  const temperature = Number((4 + 7 * Math.sin(((hour - 9) / 24) * Math.PI * 2)).toFixed(1));

  return {
    time: time.toISOString(),
    symbol: `${isNight ? 'n' : 'd'}${index % 3 === 0 ? '300' : index % 5 === 0 ? '421' : '200'}`,
    symbolPhrase: index % 5 === 0 ? 'мокрый снег' : 'облачно',
    temperature,
    feelsLikeTemp: Number((temperature - 2).toFixed(1)),
    windSpeed: 3.4,
    windGust: 7.1,
    relHumidity: 78,
    dewPoint: Number((temperature - 4).toFixed(1)),
    windDir: 220,
    windDirString: 'SW',
    precipProb: index % 4 === 0 ? 45 : 10,
    precipAccum: index % 6 === 0 ? 1.2 : 0,
    snowAccum: 0,
    cloudiness: 65,
    thunderProb: 0,
    uvIndex: isNight ? 0 : 1.4,
    pressure: 1013.2,
    visibility: 24_000,
    precipType: 'rain',
    solarRadiation: isNight ? 0 : 120,
  };
}

/** 64 шага по 3 часа — примерно 8 суток, с запасом для обрезки до семи. */
export const threeHourlyResponse: Record<string, unknown> = {
  forecast: Array.from({ length: 64 }, (_, index) => step(index)),
};

/** Ответ без единого шага: используется для проверки отбраковки. */
export const emptyThreeHourlyResponse: Record<string, unknown> = {
  forecast: [],
};

export const locationResponse: Record<string, unknown> = {
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
};

export const locationSearchResponse: Record<string, unknown> = {
  locations: [
    {
      id: 100184745,
      name: 'Караганда',
      country: 'Казахстан',
      timezone: 'Asia/Almaty',
      language: 'ru',
      adminArea: 'Карагандинская область',
      adminArea2: 'Караганда',
      adminArea3: null,
      lon: 73.1094,
      lat: 49.8047,
    },
    {
      id: 100184746,
      name: 'Караганда',
      country: 'Россия',
      timezone: 'Asia/Yekaterinburg',
      language: 'ru',
      adminArea: 'Челябинская область',
      adminArea2: 'Карталинский район',
      adminArea3: null,
      lon: 60.1,
      lat: 55.2,
    },
  ],
};

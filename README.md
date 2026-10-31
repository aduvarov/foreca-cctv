# foreca-cctv

Виртуальная CCTV-камера: недельный прогноз Foreca как RTSP-поток для аппаратного
видеорегистратора. Регистратор видит обычную камеру 640x480 и показывает прогноз
на мониторе охраны.

## Что нужно

- Node.js 20+
- FFmpeg с `libx264`
- MediaMTX (RTSP-сервер)
- токен [Foreca Weather API](https://developer.foreca.com)

## Установка

```bash
npm install
```

## Запуск

Первый запуск в терминале: мастер спросит токен и город, проверит токен запросом
к Foreca и сохранит `config.json` с правами `0600`.

```bash
npm start
```

В контейнере без терминала параметры задаются окружением:

```bash
FORECA_TOKEN=... FORECA_LOCATION="Караганда" npm start
```

Доступные параметры:

| Параметр            | Назначение                                       |
| ------------------- | ------------------------------------------------ |
| `--config <path>`   | путь к конфигурации (по умолчанию `config.json`) |
| `--reconfigure`     | заново запустить мастер настройки                |
| `--non-interactive` | не задавать вопросов                             |
| `--help`            | справка                                          |

Переменные окружения: `FORECA_TOKEN`, `FORECA_LOCATION`, `FORECA_CONFIG`.

## Конфигурация

Образец — `config.example.json`. Реальный `config.json` в репозиторий не попадает:
в нём токен.

```json
{
  "forecaToken": "...",
  "location": { "name": "Караганда", "lat": 49.8047, "lon": 73.1094, "timezone": "Asia/Almaty" },
  "stream": {
    "fps": 1,
    "bitrateKbps": 400,
    "width": 640,
    "height": 480,
    "rtspUrl": "rtsp://127.0.0.1:8554/weather"
  },
  "api": { "refreshMinutes": 30, "staleAfterMinutes": 90 },
  "state": { "cacheDir": "./state", "healthPort": 9970, "healthHost": "127.0.0.1" }
}
```

## MediaMTX

```bash
mediamtx mediamtx.yml
```

Конфигурация `mediamtx.yml` поднимает два пути на один поток:

```
rtsp://<host>:8554/weather       — точка публикации
rtsp://<host>:8554/weather_sub   — редирект на основной путь
```

Заглушка `assets/offline/no-data.mp4` отдаётся, когда сервис не публикует поток,
поэтому регистратор видит канал всегда. Пересоздать заглушку:

```bash
npx tsx scripts/make-offline-video.ts
```

## Проверка

```bash
curl http://127.0.0.1:9970/health          # состояние публикации и данных
curl -o frame.png http://127.0.0.1:9970/snapshot.png   # текущий кадр
```

## Разработка

```bash
npm run typecheck     # строгий TypeScript
npm run lint
npm test              # 267 тестов
npm run codegen       # типы и zod-схемы Foreca из OpenAPI
npx tsx scripts/render-sample.ts sample.png   # кадр в файл
```

### Типы Foreca

Типы и валидаторы генерируются из `foreca-weather-api.openapi.json`:

```
foreca-weather-api.openapi.json
   -> build/foreca.normalized.json     (уникальные operationId)
   -> src/generated/{types,zod}.gen.ts (коммитятся)
```

Спека не содержит `required` и имеет дубли `operationId`, поэтому нормализация
обязательна. Руками сгенерированные файлы не правят.

### Ограничения окружения

- `@napi-rs/canvas` зафиксирован на **0.1.88**: в 0.1.89+ утечка около 8 КБ
  на кадр при отрисовке, в 1.x — на `data()`. Тест на память это отслеживает.
- FFmpeg стартует в публикацию примерно за 5 секунд; до этого MediaMTX отдаёт
  заглушку.
- Публикация идёт по RTSP/TCP: UDP через NAT нестабилен.

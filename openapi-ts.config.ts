import { defineConfig } from '@hey-api/openapi-ts';

/**
 * Кодогенерация типов и zod-схем строго из нормализованной спеки.
 *
 * `build/foreca.normalized.json` — результат `npm run openapi:normalize`.
 * Плагин zod даёт валидаторы на границе: в спеке Foreca нет ни одного
 * `required`, поэтому все поля необязательные, и проверка структуры обязательна.
 *
 * Линтер к генерату не применяется: он сгенерирован и не должен правиться руками.
 */
export default defineConfig({
  // Hey API трактует строку без "./" как shorthand вида organization/project,
  // поэтому путь к локальному файлу указан явно относительным.
  input: './build/foreca.normalized.json',
  output: {
    path: 'src/generated',
    postProcess: ['prettier'],
  },
  plugins: ['@hey-api/typescript', 'zod'],
});

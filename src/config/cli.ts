/**
 * Разбор способа запуска: флаги, переменные окружения, признак терминала.
 *
 * Мастер настройки не должен вешать контейнер: при отсутствии TTY и отсутствии
 * параметров сервис обязан завершиться с понятной ошибкой.
 */
export interface CliOptions {
  readonly configPath: string | undefined;
  readonly reconfigure: boolean;
  readonly nonInteractive: boolean;
  readonly help: boolean;
  readonly token: string | undefined;
  readonly location: string | undefined;
}

export interface EnvLike {
  readonly FORECA_TOKEN?: string | undefined;
  readonly FORECA_LOCATION?: string | undefined;
  readonly FORECA_CONFIG?: string | undefined;
}

export interface ParseArgsResult {
  readonly options: CliOptions;
  readonly problems: readonly string[];
}

const USAGE = `Использование: foreca-cctv [параметры]

Параметры:
  --config <path>      путь к файлу конфигурации (по умолчанию config.json)
  --reconfigure        запустить мастер настройки заново
  --non-interactive    не задавать вопросов; параметры берутся из окружения
  --token <token>      токен Foreca (альтернатива FORECA_TOKEN)
  --location <query>   название или координаты локации (FORECA_LOCATION)
  -h, --help           показать эту справку

Переменные окружения:
  FORECA_TOKEN         токен Foreca
  FORECA_LOCATION      локация для поиска
  FORECA_CONFIG        путь к файлу конфигурации
`;

export function usage(): string {
  return USAGE;
}

export function parseArgs(argv: readonly string[], env: EnvLike = {}): ParseArgsResult {
  const problems: string[] = [];
  let configPath = env.FORECA_CONFIG;
  let reconfigure = false;
  let nonInteractive = false;
  let help = false;
  let token = env.FORECA_TOKEN;
  let location = env.FORECA_LOCATION;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--config': {
        const value = argv[index + 1];
        if (value === undefined) problems.push('Параметр --config требует значение');
        else {
          configPath = value;
          index += 1;
        }
        break;
      }
      case '--reconfigure':
        reconfigure = true;
        break;
      case '--non-interactive':
        nonInteractive = true;
        break;
      case '--token': {
        const value = argv[index + 1];
        if (value === undefined) problems.push('Параметр --token требует значение');
        else {
          token = value;
          index += 1;
        }
        break;
      }
      case '--location': {
        const value = argv[index + 1];
        if (value === undefined) problems.push('Параметр --location требует значение');
        else {
          location = value;
          index += 1;
        }
        break;
      }
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        problems.push(`Неизвестный параметр: ${String(argument)}`);
    }
  }

  return {
    options: { configPath, reconfigure, nonInteractive, help, token, location },
    problems,
  };
}

/** Признак интерактивности: stdin и stdout должны быть терминалами. */
export function isInteractive(
  streams: { stdin?: { isTTY?: boolean } | undefined; stdout?: { isTTY?: boolean } | undefined } = {
    stdin: process.stdin,
    stdout: process.stdout,
  },
): boolean {
  return streams.stdin?.isTTY === true && streams.stdout?.isTTY === true;
}

/**
 * Решает, что делать при старте.
 *
 * Явная функция, а не цепочка if в точке входа: решений всего пять,
 * и каждое должно быть проверяемо тестом.
 */
export type StartupPlan =
  | { readonly action: 'help' }
  | { readonly action: 'fail'; readonly message: string }
  | { readonly action: 'run'; readonly configPath: string }
  | { readonly action: 'wizard'; readonly configPath: string }
  | { readonly action: 'bootstrap'; readonly configPath: string };

export interface DecideStartupInput {
  readonly options: CliOptions;
  readonly interactive: boolean;
  readonly config: { readonly kind: 'missing' | 'invalid' | 'loaded'; readonly path: string };
  readonly hasNonInteractiveSource: boolean;
}

export function decideStartup(input: DecideStartupInput): StartupPlan {
  const { options, interactive, config } = input;

  if (options.help) {
    return { action: 'help' };
  }

  if (options.reconfigure) {
    if (!interactive && !input.hasNonInteractiveSource) {
      return {
        action: 'fail',
        message:
          'Повторная настройка без терминала невозможна: задайте FORECA_TOKEN и FORECA_LOCATION',
      };
    }
    return { action: 'wizard', configPath: config.path };
  }

  if (config.kind === 'loaded') {
    return { action: 'run', configPath: config.path };
  }

  if (config.kind === 'invalid') {
    // Повреждённый файл не заменяем молча: пользователь должен знать.
    return {
      action: 'fail',
      message: `Файл конфигурации ${config.path} не прошёл проверку. Исправьте его или запустите с --reconfigure`,
    };
  }

  if (input.hasNonInteractiveSource) {
    return { action: 'bootstrap', configPath: config.path };
  }

  if (interactive) {
    return { action: 'wizard', configPath: config.path };
  }

  return {
    action: 'fail',
    message:
      'Конфигурация не найдена, а терминал недоступен. Задайте FORECA_TOKEN и FORECA_LOCATION или смонтируйте config.json',
  };
}

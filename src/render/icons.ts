/**
 * Рисование иконок погоды по кодам Foreca.
 *
 * Код устроен как `d421`: день/ночь, облачность, интенсивность, тип осадков.
 * Официальные SVG доступны только через My API, поэтому иконки рисуются сами —
 * но строго по той же семантике кода, чтобы замена на официальные не меняла
 * логику выбора.
 *
 * Функции принимают `SKRSContext2D` и не знают про доменную модель:
 * им передаётся уже разобранный код.
 */
import type { SKRSContext2D } from '@napi-rs/canvas';

import type { Theme } from './theme.js';

export interface SymbolParts {
  readonly isNight: boolean;
  /** 0 — ясно, 1 — почти ясно, 2 — половина облачности, 3 — облачно, 4 — пасмурно. */
  readonly cloudiness: number;
  /** 0 — нет осадков, 1 — слабые, 2 — ливни, 3 — осадки, 4 — гроза. */
  readonly precipitation: number;
  /** 0 — дождь, 1 — мокрый снег, 2 — снег. */
  readonly precipitationType: number;
}

/**
 * Разбирает код символа. Возвращает `undefined` для нераспознанного кода:
 * вызывающий рисует нейтральную заглушку.
 */
export function parseSymbol(code: string | undefined): SymbolParts | undefined {
  if (code === undefined) return undefined;
  const match = /^([dn])(\d)(\d)(\d)$/.exec(code.trim().toLowerCase());
  if (match === null) return undefined;

  const [, dayNight, cloud, precip, type] = match;
  if (dayNight === undefined || cloud === undefined || precip === undefined || type === undefined) {
    return undefined;
  }

  const cloudiness = Number(cloud);
  const precipitation = Number(precip);
  const precipitationType = Number(type);

  // 5 и 6 (высокие облака и туман) в макете трактуются как облачность/туман.
  if (cloudiness > 6) return undefined;

  return {
    isNight: dayNight === 'n',
    cloudiness: Math.min(cloudiness, 4),
    precipitation: Math.min(precipitation, 4),
    precipitationType: Math.min(precipitationType, 2),
  };
}

export interface IconOptions {
  readonly centerX: number;
  readonly centerY: number;
  /** Радиус иконки: от него масштабируются все элементы. */
  readonly radius: number;
  readonly theme: Theme;
}

/** Рисует иконку по коду; нераспознанный код даёт нейтральный кружок. */
export function drawWeatherIcon(
  ctx: SKRSContext2D,
  code: string | undefined,
  options: IconOptions,
): void {
  const parts = parseSymbol(code);
  if (parts === undefined) {
    drawFallback(ctx, options);
    return;
  }
  drawIcon(ctx, parts, options);
}

export function drawIcon(ctx: SKRSContext2D, parts: SymbolParts, options: IconOptions): void {
  const { centerX, centerY, radius, theme } = options;
  const { colors } = theme;

  // Ясно и почти ясно: солнце или луна без облака.
  if (parts.cloudiness <= 1) {
    if (parts.isNight) {
      drawMoon(ctx, centerX, centerY, radius, colors.iconMoon, theme.colors.backgroundTop);
    } else {
      drawSun(ctx, centerX, centerY, radius, colors.iconSun);
    }
    return;
  }

  // Половина облачности днём: солнце за облаком.
  if (parts.cloudiness === 2 && !parts.isNight) {
    ctx.fillStyle = colors.iconSun;
    ctx.beginPath();
    ctx.arc(centerX - radius * 0.44, centerY - radius * 0.36, radius * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }

  const cloudColor = parts.cloudiness >= 4 ? colors.iconCloudDark : colors.iconCloud;
  drawCloud(ctx, centerX, centerY, radius, cloudColor);

  if (parts.precipitation > 0) {
    drawPrecipitation(ctx, centerX, centerY, radius, parts, theme);
  }
}

function drawSun(
  ctx: SKRSContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.44, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, radius * 0.14);
  for (let index = 0; index < 8; index += 1) {
    const angle = (index * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(
      centerX + Math.cos(angle) * radius * 0.64,
      centerY + Math.sin(angle) * radius * 0.64,
    );
    ctx.lineTo(
      centerX + Math.cos(angle) * radius * 0.88,
      centerY + Math.sin(angle) * radius * 0.88,
    );
    ctx.stroke();
  }
}

function drawMoon(
  ctx: SKRSContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  color: string,
  background: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(centerX - radius * 0.12, centerY, radius * 0.6, 0, Math.PI * 2);
  ctx.fill();

  // Полумесяц: перекрываем диск цветом фона. На градиенте это заметно,
  // поэтому перекрытие берётся из того же градиента, что и фон кадра.
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.arc(centerX + radius * 0.26, centerY - radius * 0.24, radius * 0.56, 0, Math.PI * 2);
  ctx.fill();
}

function drawCloud(
  ctx: SKRSContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(centerX - radius * 0.32, centerY + radius * 0.12, radius * 0.33, 0, Math.PI * 2);
  ctx.arc(centerX + radius * 0.04, centerY - radius * 0.12, radius * 0.43, 0, Math.PI * 2);
  ctx.arc(centerX + radius * 0.44, centerY + radius * 0.14, radius * 0.31, 0, Math.PI * 2);
  ctx.fill();
}

function drawPrecipitation(
  ctx: SKRSContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  parts: SymbolParts,
  theme: Theme,
): void {
  const { colors } = theme;

  if (parts.precipitation === 4) {
    // Гроза: молния поверх осадков.
    ctx.fillStyle = colors.iconThunder;
    ctx.beginPath();
    ctx.moveTo(centerX + radius * 0.06, centerY + radius * 0.42);
    ctx.lineTo(centerX - radius * 0.14, centerY + radius * 0.86);
    ctx.lineTo(centerX + radius * 0.1, centerY + radius * 0.8);
    ctx.lineTo(centerX - radius * 0.04, centerY + radius * 1.14);
    ctx.lineTo(centerX + radius * 0.32, centerY + radius * 0.62);
    ctx.closePath();
    ctx.fill();
    return;
  }

  const isSnow = parts.precipitationType === 2;
  for (let index = -1; index <= 1; index += 1) {
    const x = centerX + index * radius * 0.33;
    if (isSnow) {
      ctx.fillStyle = colors.iconSnow;
      ctx.beginPath();
      ctx.arc(x, centerY + radius * 0.66, Math.max(1, radius * 0.13), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = parts.precipitationType === 1 ? colors.iconSnow : colors.iconRain;
      ctx.lineWidth = Math.max(1, radius * 0.16);
      ctx.beginPath();
      ctx.moveTo(x, centerY + radius * 0.5);
      ctx.lineTo(x, centerY + radius * 0.8);
      ctx.stroke();
    }
  }
}

/** Нейтральная заглушка: код отсутствует или не распознан. */
function drawFallback(ctx: SKRSContext2D, options: IconOptions): void {
  const { centerX, centerY, radius, theme } = options;
  ctx.strokeStyle = theme.colors.muted;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.55, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = theme.colors.muted;
  ctx.font = `${Math.round(radius * 0.9)}px ForecaSans`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', centerX, centerY + radius * 0.04);
  ctx.textBaseline = 'alphabetic';
}

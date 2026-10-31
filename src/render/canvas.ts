/**
 * Рисование кадра по готовому layout.
 *
 * Модуль не принимает решений о данных: только пишет примитивы. Это позволяет
 * менять вид, не трогая доменную модель, и наоборот.
 */
import type { Image, SKRSContext2D } from '@napi-rs/canvas';

import { traceSmoothLine } from './curve.js';
import { drawWeatherIcon } from './icons.js';
import { dateLabel, displaySlots, updatedLabel, weekdayLabel } from './layout.js';
import type { ChartLayout } from './layout.js';
import type { Theme } from './theme.js';

export interface DrawOptions {
  readonly ctx: SKRSContext2D;
  readonly layout: ChartLayout;
  /** Логотип Foreca в версии WRC; обязателен по условиям API. */
  readonly logo: Image | undefined;
}

export function drawFrame(options: DrawOptions): void {
  const { ctx, layout } = options;
  const { theme } = layout;

  drawBackground(ctx, theme);
  drawHeader(ctx, layout, theme);
  drawDayHeaders(ctx, layout, theme);
  drawIcons(ctx, layout, theme);
  drawAxis(ctx, layout, theme);
  drawTemperature(ctx, layout, theme);
  drawExtremes(ctx, layout, theme);
  drawPrecipitation(ctx, layout, theme);
  drawWind(ctx, layout, theme);
  drawFooter(ctx, options, theme);
}

function drawBackground(ctx: SKRSContext2D, theme: Theme): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, theme.height);
  gradient.addColorStop(0, theme.colors.backgroundTop);
  gradient.addColorStop(1, theme.colors.backgroundBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, theme.width, theme.height);
}

function drawHeader(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  const { padding } = theme;
  const { chart } = layout;

  ctx.textAlign = 'left';
  ctx.fillStyle = theme.colors.title;
  ctx.font = theme.fonts.title;
  ctx.fillText(`Погода в ${chart.locationName}`, padding, theme.layout.titleBaseline);

  ctx.fillStyle = theme.colors.subtitle;
  ctx.font = theme.fonts.subtitle;
  ctx.fillText('ПРОГНОЗ НА НЕДЕЛЮ', padding, theme.layout.subtitleBaseline);

  ctx.textAlign = 'right';
  ctx.fillStyle = theme.colors.subtitle;
  ctx.font = theme.fonts.subtitle;
  ctx.fillText(updatedLabel(chart), theme.width - padding, theme.layout.subtitleBaseline);

  if (chart.stale) {
    drawStaleBadge(ctx, layout, theme);
  }
}

/** Бейдж устаревания: заметный, но не перекрывает данные. */
function drawStaleBadge(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  const text = `данные устарели · ${layout.chart.ageMinutes} мин`;
  ctx.font = theme.fonts.badge;
  const width = ctx.measureText(text).width + 16;
  const height = 18;
  const right = theme.width - theme.padding;
  const x = right - width;
  const y = theme.layout.subtitleBaseline - 14;

  ctx.fillStyle = theme.colors.staleBadgeBackground;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 3);
  ctx.fill();

  ctx.fillStyle = theme.colors.staleBadgeText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + width / 2, y + height / 2 + 0.5);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
}

function drawDayHeaders(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  ctx.textAlign = 'center';

  layout.chart.days.forEach((day, index) => {
    const centerX = layout.geometry.dayCenter(index);
    const isToday = index === 0;

    ctx.fillStyle = isToday ? '#93c5fd' : theme.colors.text;
    ctx.font = theme.fonts.day;
    ctx.fillText(weekdayLabel(day.weekday), centerX, theme.layout.dayBaseline);

    ctx.fillStyle = isToday ? '#60a5fa' : theme.colors.muted;
    ctx.font = theme.fonts.date;
    ctx.fillText(dateLabel(day.dateKey), centerX, theme.layout.dateBaseline);
  });
}

function drawIcons(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  ctx.textAlign = 'center';

  layout.chart.days.forEach((day, dayIndex) => {
    const slots = displaySlots(day);
    if (slots.length === 0) return;

    // Позиция считается по индексу шага в дне, а не по индексу среди выбранных:
    // иначе иконки разъезжаются с точками кривой.
    const slotWidth = layout.geometry.dayWidth / day.slots.length;

    slots.forEach((slot) => {
      const slotIndex = day.slots.indexOf(slot);
      if (slotIndex < 0) return;

      const centerX =
        layout.geometry.left + dayIndex * layout.geometry.dayWidth + (slotIndex + 0.5) * slotWidth;

      drawWeatherIcon(ctx, slot.symbol, {
        centerX,
        centerY: theme.layout.iconCenterY,
        radius: 8,
        theme,
      });

      ctx.fillStyle = theme.colors.subtitle;
      ctx.font = theme.fonts.hour;
      ctx.fillText(String(slot.hour), centerX, theme.layout.hourBaseline);
    });
  });
}

function drawAxis(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  const { geometry } = layout;
  ctx.font = theme.fonts.axis;
  ctx.textAlign = 'right';

  for (const tick of geometry.ticks) {
    const y = geometry.yFor(tick);
    ctx.strokeStyle = tick === 0 ? theme.colors.zeroLine : theme.colors.grid;
    ctx.lineWidth = tick === 0 ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(geometry.left - 6, y);
    ctx.lineTo(geometry.right, y);
    ctx.stroke();

    ctx.fillStyle = tick === 0 ? '#8fa3bf' : '#4b5b75';
    ctx.fillText(String(tick), geometry.left - 9, y + 3);
  }

  // Разделители дней.
  ctx.strokeStyle = theme.colors.grid;
  ctx.lineWidth = 1;
  layout.chart.days.forEach((_day, index) => {
    if (index === 0) return;
    const x = geometry.left + index * geometry.dayWidth;
    ctx.beginPath();
    ctx.moveTo(x, geometry.top);
    ctx.lineTo(x, geometry.bottom);
    ctx.stroke();
  });

  ctx.fillStyle = theme.colors.muted;
  ctx.font = theme.fonts.axis;
  ctx.textAlign = 'left';
  ctx.fillText('°C', geometry.left - 15, geometry.top - 3);
}

function drawTemperature(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  ctx.strokeStyle = theme.colors.temperature;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const segment of layout.segments) {
    if (segment.points.length === 1) {
      const only = segment.points[0];
      if (only === undefined) continue;
      ctx.fillStyle = theme.colors.temperature;
      ctx.beginPath();
      ctx.arc(only.x, only.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    traceSmoothLine(ctx, segment.points);
    ctx.stroke();
  }
}

function drawExtremes(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  for (const extreme of layout.extremes) {
    ctx.beginPath();
    ctx.arc(extreme.x, extreme.y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle =
      extreme.kind === 'max' ? theme.colors.temperature : theme.colors.temperatureCold;
    ctx.fill();
  }
}

function drawPrecipitation(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  ctx.textAlign = 'center';

  for (const bar of layout.precipitation) {
    if (bar.height <= 0.8) continue;
    ctx.fillStyle = theme.colors.precipitation;
    ctx.beginPath();
    const x = bar.x;
    const y = bar.baseline - bar.height;
    ctx.roundRect(x, y, bar.width, bar.height, 1);
    ctx.fill();
  }

  for (const bar of layout.precipitation) {
    if (bar.value < 0.05) continue;
    ctx.fillStyle = theme.colors.precipitationLabel;
    ctx.font = theme.fonts.label;
    ctx.fillText(bar.value.toFixed(1), bar.x + bar.width / 2, bar.baseline + 10);
  }

  ctx.fillStyle = theme.colors.muted;
  ctx.font = theme.fonts.axis;
  ctx.textAlign = 'left';
  ctx.fillText('мм', layout.geometry.left - 15, theme.layout.precipBottom + 10);
}

function drawWind(ctx: SKRSContext2D, layout: ChartLayout, theme: Theme): void {
  ctx.fillStyle = theme.colors.muted;
  ctx.font = theme.fonts.axis;
  ctx.textAlign = 'left';
  ctx.fillText('ветер', layout.geometry.left - 15, theme.layout.windCenterY + 4);

  ctx.textAlign = 'center';
  layout.chart.days.forEach((day, index) => {
    const wind = day.wind;
    if (wind === undefined) return;

    const centerX = layout.geometry.dayCenter(index);
    const centerY = theme.layout.windCenterY;
    // API говорит, откуда дует ветер; стрелка показывает, куда он дует.
    const angle = (wind.directionTo * Math.PI) / 180;
    const length = 5;

    ctx.strokeStyle = theme.colors.wind;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(centerX - Math.cos(angle) * length, centerY - Math.sin(angle) * length);
    ctx.lineTo(centerX + Math.cos(angle) * length, centerY + Math.sin(angle) * length);
    ctx.stroke();

    ctx.fillStyle = theme.colors.wind;
    ctx.beginPath();
    ctx.arc(
      centerX + Math.cos(angle) * length,
      centerY + Math.sin(angle) * length,
      1.8,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    ctx.fillStyle = theme.colors.muted;
    ctx.font = theme.fonts.label;
    ctx.fillText(`${formatSpeed(wind.speedMs)} м/с`, centerX, theme.layout.windLabelBaseline);
  });
}

function formatSpeed(speed: number): string {
  return Number.isInteger(speed) ? String(speed) : speed.toFixed(1);
}

function drawFooter(ctx: SKRSContext2D, options: DrawOptions, theme: Theme): void {
  drawLogo(ctx, options.logo, theme);
}

/**
 * Рисует логотип Foreca с обязательным свободным полем.
 *
 * Отсутствие логотипа — ошибка, а не тихий пропуск: кадр без атрибуции
 * нарушает условия использования API.
 */
export function drawLogo(ctx: SKRSContext2D, logo: Image | undefined, theme: Theme): void {
  if (logo === undefined) {
    throw new Error('Логотип Foreca не загружен: атрибуция обязательна');
  }

  const height = theme.logo.height;
  const width = Math.round((height * logo.width) / logo.height);
  const x = theme.width - theme.padding - width;
  const y = theme.height - theme.padding - height;

  const freeSpace = theme.logo.minFreeSpace;
  if (x - freeSpace < 0 || y - freeSpace < 0) {
    throw new Error('Логотип не помещается с требуемым свободным полем');
  }

  ctx.drawImage(logo, x, y, width, height);
}

/** Кадр «нет данных»: сообщение вместо графика, логотип сохраняется. */
export function drawEmptyFrame(
  ctx: SKRSContext2D,
  theme: Theme,
  logo: Image | undefined,
  message: string,
): void {
  drawBackground(ctx, theme);

  ctx.textAlign = 'center';
  ctx.fillStyle = theme.colors.title;
  ctx.font = theme.fonts.title;
  ctx.fillText(message, theme.width / 2, theme.height / 2 - 10);

  ctx.fillStyle = theme.colors.muted;
  ctx.font = theme.fonts.label;
  ctx.fillText(
    'данные появятся после первого успешного обновления',
    theme.width / 2,
    theme.height / 2 + 14,
  );

  ctx.textAlign = 'left';
  drawLogo(ctx, logo, theme);
}

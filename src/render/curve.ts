/**
 * Сглаженная кривая температуры.
 *
 * Catmull-Rom в форме Безье даёт плавную линию, но может «выбросить» точку за
 * пределы соседних значений. На графике погоды это читается как ложный минимум,
 * поэтому управляющие точки ограничиваются диапазоном пары соседей.
 *
 * Пропуск в данных рвёт линию: интерполировать через отсутствующее значение
 * нельзя, это выдуманная погода.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Segment {
  readonly points: readonly Point[];
}

/**
 * Строит сегменты по точкам. Точка со значением `null` означает пропуск
 * и разрывает линию на два сегмента.
 */
export function buildSegments(points: readonly (Point | null)[]): Segment[] {
  const segments: Segment[] = [];
  let current: Point[] = [];

  for (const point of points) {
    if (point === null) {
      if (current.length > 0) segments.push({ points: current });
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 0) segments.push({ points: current });
  return segments;
}

/**
 * Рисует сглаженную линию через точки сегмента.
 *
 * Ограничение: управляющая точка не выходит за вертикальный диапазон соседних
 * значений, поэтому сплайн не создаёт локальных экстремумов, которых нет в данных.
 */
export function traceSmoothLine(
  ctx: {
    beginPath: () => void;
    moveTo: (x: number, y: number) => void;
    bezierCurveTo: (
      c1x: number,
      c1y: number,
      c2x: number,
      c2y: number,
      x: number,
      y: number,
    ) => void;
  },
  points: readonly Point[],
): void {
  ctx.beginPath();
  const first = points[0];
  if (first === undefined) return;

  ctx.moveTo(first.x, first.y);
  if (points.length === 1) return;

  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[index + 2] ?? next;
    if (
      previous === undefined ||
      current === undefined ||
      next === undefined ||
      afterNext === undefined
    ) {
      continue;
    }

    const firstControl = clampControl(
      current.x + (next.x - previous.x) / 6,
      current.y + (next.y - previous.y) / 6,
      current.y,
      next.y,
    );
    const secondControl = clampControl(
      next.x - (afterNext.x - current.x) / 6,
      next.y - (afterNext.y - current.y) / 6,
      current.y,
      next.y,
    );

    ctx.bezierCurveTo(
      firstControl.x,
      firstControl.y,
      secondControl.x,
      secondControl.y,
      next.x,
      next.y,
    );
  }
}

/** Ограничивает управляющую точку диапазоном значений между соседними точками. */
export function clampControl(x: number, y: number, fromY: number, toY: number): Point {
  const low = Math.min(fromY, toY);
  const high = Math.max(fromY, toY);
  return { x, y: Math.min(Math.max(y, low), high) };
}

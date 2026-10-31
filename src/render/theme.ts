/**
 * Тема кадра.
 *
 * Все размеры и цвета в одном месте: макет фиксирован, и правки вида не должны
 * расползаться по коду рисования.
 *
 * Макет нарисован в координатах базового разрешения D1 704x576. Другие размеры
 * получаются не отдельной вёрсткой, а масштабированием: пропорции сохраняются,
 * а шрифты и отступы растут вместе с кадром. Так один макет обслуживает
 * несколько разрешений.
 */
export interface Theme {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly colors: {
    readonly backgroundTop: string;
    readonly backgroundBottom: string;
    readonly title: string;
    readonly subtitle: string;
    readonly text: string;
    readonly muted: string;
    readonly grid: string;
    readonly gridStrong: string;
    readonly zeroLine: string;
    readonly temperature: string;
    readonly temperatureCold: string;
    readonly precipitation: string;
    readonly precipitationLabel: string;
    readonly wind: string;
    readonly staleBadgeBackground: string;
    readonly staleBadgeText: string;
    readonly iconCloud: string;
    readonly iconCloudDark: string;
    readonly iconSun: string;
    readonly iconMoon: string;
    readonly iconRain: string;
    readonly iconSnow: string;
    readonly iconThunder: string;
  };
  readonly fonts: {
    readonly title: string;
    readonly subtitle: string;
    readonly day: string;
    readonly date: string;
    readonly hour: string;
    readonly axis: string;
    readonly label: string;
    readonly badge: string;
    /** Подписи значений у точек экстремумов: размер как у дня недели. */
    readonly extreme: string;
    /** Подписи скорости ветра под стрелкой. */
    readonly wind: string;
  };
  /** Логотип: высота и требование свободного поля вокруг. */
  readonly logo: {
    readonly height: number;
    readonly minFreeSpace: number;
  };
  /** Раскладка областей сверху вниз. */
  readonly layout: {
    readonly titleBaseline: number;
    readonly subtitleBaseline: number;
    readonly dayBaseline: number;
    readonly dateBaseline: number;
    readonly iconCenterY: number;
    readonly hourBaseline: number;
    readonly chartTop: number;
    readonly chartBottom: number;
    readonly precipTop: number;
    readonly precipBottom: number;
    readonly windCenterY: number;
    readonly windLabelBaseline: number;
    /** Радиус иконки погоды. */
    readonly iconRadius: number;
  };
}

/**
 * Базовое разрешение, под которое нарисован макет.
 *
 * 704x576 — формат D1: его поддерживает большинство аппаратных регистраторов,
 * и он даёт чуть больше места подписям при том же характере картинки.
 */
export const BASE_WIDTH = 704;
export const BASE_HEIGHT = 576;

const colors: Theme['colors'] = {
  backgroundTop: '#111c30',
  backgroundBottom: '#0a1120',
  title: '#f1f5f9',
  subtitle: '#5b6b84',
  text: '#dbe4f0',
  muted: '#7c8ca6',
  grid: '#1c2739',
  gridStrong: '#3d4d66',
  zeroLine: '#3d4d66',
  temperature: '#f43f5e',
  temperatureCold: '#38bdf8',
  precipitation: '#2f6fd0',
  precipitationLabel: '#7aa7e8',
  wind: '#4ade80',
  staleBadgeBackground: '#7f1d1d',
  staleBadgeText: '#fecaca',
  iconCloud: '#cbd5e1',
  iconCloudDark: '#94a3b8',
  iconSun: '#fbbf24',
  iconMoon: '#e2e8f0',
  iconRain: '#38bdf8',
  iconSnow: '#e2e8f0',
  iconThunder: '#facc15',
};

/** Макет в координатах базового разрешения 640x480. */
const base = {
  padding: 12,
  fonts: {
    titleBold: 22,
    subtitle: 9,
    dayBold: 12,
    date: 9,
    hour: 8,
    axis: 9,
    label: 10,
    badgeBold: 10,
    // Подписи экстремумов и ветра намеренно крупные: места по ширине дня
    // хватает (95 px против 23 px у подписи), а читаемость на мониторе
    // охраны важнее компактности.
    extremeBold: 12,
    wind: 13,
  },
  logoHeight: 26,
  layout: {
    titleBaseline: 28,
    subtitleBaseline: 42,
    dayBaseline: 62,
    dateBaseline: 74,
    iconCenterY: 92,
    hourBaseline: 110,
    chartTop: 126,
    chartBottom: 300,
    precipTop: 314,
    precipBottom: 350,
    windCenterY: 378,
    windLabelBaseline: 396,
    iconRadius: 8,
  },
};

/**
 * Строит тему для произвольного размера.
 *
 * Масштаб берётся по высоте: раскладка вертикальная, и при 704x576 кадр выше
 * на 20%, поэтому все отступы и шрифты увеличиваются пропорционально.
 * Ширина при этом используется как есть — сетка по дням растягивается сама.
 */
export function createTheme(width = BASE_WIDTH, height = BASE_HEIGHT): Theme {
  const scale = height / BASE_HEIGHT;

  const px = (value: number): number => Math.round(value * scale);
  // Ниже 8 px текст после сжатия H.264 уже не читается.
  const font = (value: number, weight: 'normal' | 'bold'): string =>
    `${weight === 'bold' ? 'bold ' : ''}${Math.max(8, px(value))}px ${weight === 'bold' ? 'ForecaSansBold' : 'ForecaSans'}`;

  return {
    width,
    height,
    padding: px(base.padding),
    colors,
    fonts: {
      title: font(base.fonts.titleBold, 'bold'),
      subtitle: font(base.fonts.subtitle, 'normal'),
      day: font(base.fonts.dayBold, 'bold'),
      date: font(base.fonts.date, 'normal'),
      hour: font(base.fonts.hour, 'normal'),
      axis: font(base.fonts.axis, 'normal'),
      label: font(base.fonts.label, 'normal'),
      badge: font(base.fonts.badgeBold, 'bold'),
      extreme: font(base.fonts.extremeBold, 'bold'),
      wind: font(base.fonts.wind, 'normal'),
    },
    logo: {
      height: px(base.logoHeight),
      // Требование Foreca: свободное поле не меньше половины высоты логотипа.
      minFreeSpace: Math.ceil(px(base.logoHeight) / 2),
    },
    layout: {
      titleBaseline: px(base.layout.titleBaseline),
      subtitleBaseline: px(base.layout.subtitleBaseline),
      dayBaseline: px(base.layout.dayBaseline),
      dateBaseline: px(base.layout.dateBaseline),
      iconCenterY: px(base.layout.iconCenterY),
      hourBaseline: px(base.layout.hourBaseline),
      chartTop: px(base.layout.chartTop),
      chartBottom: px(base.layout.chartBottom),
      precipTop: px(base.layout.precipTop),
      precipBottom: px(base.layout.precipBottom),
      windCenterY: px(base.layout.windCenterY),
      windLabelBaseline: px(base.layout.windLabelBaseline),
      iconRadius: Math.max(6, px(base.layout.iconRadius)),
    },
  };
}

/** Тема по умолчанию: базовое разрешение 640x480. */
export const theme: Theme = createTheme();

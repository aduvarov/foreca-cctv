/**
 * Тема кадра.
 *
 * Все размеры и цвета в одном месте: макет фиксирован, и правки вида не должны
 * расползаться по коду рисования. Значения подобраны под 640x480 и проверены
 * на реальном H.264 — более мелкий текст после кодирования не читается.
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
  };
}

export const theme: Theme = {
  width: 640,
  height: 480,
  padding: 12,
  colors: {
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
  },
  fonts: {
    title: `bold 22px ForecaSansBold`,
    subtitle: `9px ForecaSans`,
    day: `bold 12px ForecaSansBold`,
    date: `9px ForecaSans`,
    hour: `8px ForecaSans`,
    axis: `9px ForecaSans`,
    label: `9px ForecaSans`,
    badge: `bold 10px ForecaSansBold`,
  },
  logo: {
    height: 26,
    // Требование Foreca: свободное поле не меньше половины высоты логотипа.
    minFreeSpace: 13,
  },
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
  },
};

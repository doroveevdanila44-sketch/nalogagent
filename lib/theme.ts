/**
 * Палитра «Озеро и зелень», единый источник значений для кода на TypeScript: метатеги
 * theme-color, цвета юрлиц в демо-данных, иконки PWA. Стили берут те же значения из токенов
 * `@theme` в app/globals.css; совпадение двух списков проверяет lib/theme.test.ts.
 * Названия: Vistoris Lake, Pale Lemon Yellow, Lincoln Green, Cobalt Green (docs/SPEC.md, раздел 5).
 */
export const PALETTE = {
  /** Основной текст, нижняя и боковая панель, кнопки, сообщения пользователя */
  ink: '#2A2B14',
  /** Приглушённый текст */
  muted: '#6B6A52',
  /** Линии и разделители */
  line: '#E7E5D3',
  /** Фон страницы */
  page: '#FFFFFF',
  /** Шапка (Vistoris Lake) */
  lake: '#A0D2A8',
  /** Выбранная вкладка, «41» на экранах входа (Pale Lemon Yellow) */
  lemon: '#FFF3B2',
  /** Акцент: фокус, полоса порога, подписи, кнопки подсказок */
  accent: '#5A5C2F',
  /** Баннеры группы, экраны входа, PIN и блокировки, «41» в шапке */
  wine: '#784244',
  /** Строки расшифровки внутри баннера: на тон светлее */
  wineSoft: '#835150',
  /** Подсказки чата и клавиши PIN при наведении и нажатии: на тон светлее бордо */
  wineHover: '#8A4F52',
  /** Второстепенный текст в баннере */
  wineSub: '#E8CFCB',
  /** Текст на баннере и на экранах входа */
  cream: '#FFF8E0',
  /** Невыбранная вкладка */
  tabIdle: '#E3E6C8',
  /** Светлая подложка */
  soft: '#FFF8D6',
  /** Подложка сообщений агента и меток */
  mint: '#EEF6EF',
  /** Текст метки «Внимание» */
  warnInk: '#4A3F00',
  /** Подсказки «Что если» в чате: светлый янтарный фон */
  amber: '#FFE6A8',
  /** Подсказки «Что если» при наведении и нажатии */
  amberHover: '#FFD986',
  /** Обводка подсказок «Что если» */
  amberLine: '#E6B04A',
} as const;

/** Цвет полосы под часами: приложение и экраны входа, PIN и блокировки */
export const THEME = { app: PALETTE.lake, auth: PALETTE.wine } as const;

/** Цвета демо-юрлиц на графике и в карточках. Сид кладёт их в базу, интерфейс берёт по id */
export const ENTITY_COLORS: Readonly<Record<string, string>> = {
  alfa: PALETTE.accent,
  beta: PALETTE.wine,
  delta: PALETTE.lake,
  gamma: PALETTE.lemon,
  epsilon: PALETTE.ink,
};

/**
 * Цвет юрлица для интерфейса. Для демо-юрлиц цвет по id из палитры: база, засеянная до смены
 * палитры, хранит прежние цвета, и без этого сайт показывал бы их до повторного сида.
 */
export function entityColor(e: { id: string; color: string }): string {
  return ENTITY_COLORS[e.id] ?? e.color;
}

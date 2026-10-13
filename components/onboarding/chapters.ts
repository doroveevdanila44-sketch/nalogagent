/**
 * Обучение: главы и шаги. В каждом шаге три короткие строки с жирными метками, по одному вопросу
 * на строку: «Что это», «Как читать», «Что делать». Заголовок карточки одно слово или короткая
 * фраза. Числа в строках живые: их считает расчётный сервис (lib/calc) в момент показа шага,
 * придуманных чисел здесь нет; пока цифры не пришли, строка читается без числа. Тексты без длинных
 * тире.
 *
 * targets: селекторы по порядку, берётся первый видимый элемент (pick: 'last' берёт последний,
 * это для ответов в чате). Элементы интерфейса помечены атрибутом data-tour.
 * path: страница шага; 'document' это страница документа (берётся последний документ с
 * пропусками или создаётся пример); null это там, где человек сейчас.
 * prepare: что показать на странице перед подсветкой (пример ответа в чате, окно расчёта).
 * menu: на шаге открыто меню из трёх точек.
 * mode: 'show' (показ: нажатия вне карточки блокируются) или 'try' («попробуйте»: разрешено
 * только нажатие по подсвеченному элементу, остальное страница не принимает).
 *
 * Файл без импортов времени выполнения: его читают и тесты.
 */

export type ChapterId = 'agent' | 'dashboard' | 'documents' | 'menu';

export const CHAPTER_TITLE: Record<ChapterId, string> = {
  agent: 'Агент',
  dashboard: 'Дашборд',
  documents: 'Документы',
  menu: 'Меню',
};

/** Живые числа из расчётного сервиса (components/onboarding/numbers.ts). Строки уже отформатированы. */
export interface TourNumbers {
  year: number;
  /** Выручка группы с начала года, «198,42 млн» */
  revenue: string;
  /** НДС начислен с начала года по выбранным ставкам */
  vatAccrued: string;
  /** НДС за год, прогноз */
  vatForecast: string;
  /** «факт 6,75 млн + остаток 1,65 млн» */
  vatSplit: string;
  /** Налог на прибыль юрлиц на ОСНО за год, прогноз */
  profit: string;
  /** Налог по УСН за год, прогноз */
  usn: string;
  /** Короткие названия юрлиц на ОСНО: «Эпсилон»; null, если таких нет */
  osno: string | null;
  warningsTotal: number;
  warningsUrgent: number;
  /** Самый большой месяц графика */
  bestMonth: { name: string; value: string } | null;
  /** Порог освобождения от НДС, «20 млн» */
  threshold: string;
  /** Освобождённое юрлицо: выручка с начала года и порог */
  exempt: { name: string; ytd: string; limit: string } | null;
  /** Плательщик с выбором ставки: налог с начала года по каждой ставке */
  rates: { name: string; items: { rate: number; sum: string }[] } | null;
}

/** Что знает тур о ходе показа: пример ответа агента, который он задал сам. */
export interface TourEnv {
  asked: boolean;
}

export type Line = string | ((n: TourNumbers | null, env: TourEnv) => string);

export type TourPath = '/agent' | '/dashboard' | '/documents' | 'document' | null;

export type Prepare = 'chat-example' | 'calc-profit';

export type StepMode = 'show' | 'try';

export interface TourStep {
  id: string;
  chapter: ChapterId;
  title: string | ((n: TourNumbers | null) => string);
  /** Что это */
  what: Line;
  /** Как читать */
  read: Line;
  /** Что делать */
  todo: Line;
  path: TourPath;
  targets: string[];
  pick?: 'first' | 'last';
  prepare?: Prepare;
  menu?: boolean;
  /** По умолчанию 'show' */
  mode?: StepMode;
}

/** Метки строк карточки по порядку. */
export const LINE_LABELS = [
  { key: 'what', label: 'Что это' },
  { key: 'read', label: 'Как читать' },
  { key: 'todo', label: 'Что делать' },
] as const;

const yearOf = (n: TourNumbers | null) => n?.year ?? new Date().getFullYear();

const pluralWarnings = (n: number) => {
  const a = n % 100;
  const b = a % 10;
  const word = a > 10 && a < 20 ? 'предупреждений' : b > 1 && b < 5 ? 'предупреждения' : b === 1 ? 'предупреждение' : 'предупреждений';
  return `${n} ${word}`;
};

export const TOUR_STEPS: readonly TourStep[] = [
  // ===== Агент =====
  {
    id: 'ask',
    chapter: 'agent',
    title: 'Вопрос агенту',
    what: 'чат, где налог объясняют обычными словами.',
    read: 'в ответе цифры из калькулятора, под ними источник и «Как посчитано».',
    todo: 'напишите вопрос своими словами, например «Сколько платить за квартал».',
    path: '/agent',
    targets: ['[data-tour="chat-input"]'],
  },
  {
    id: 'suggestions',
    chapter: 'agent',
    title: 'Подсказки',
    what: 'готовые вопросы, которые задают чаще всего.',
    read: 'нажатие сразу отправляет вопрос агенту.',
    todo: 'нажмите подсказку, если не знаете, с чего начать.',
    path: '/agent',
    targets: ['[data-tour="suggestions"]', '[data-tour="suggestions-handle"]'],
  },
  {
    id: 'forecast',
    chapter: 'agent',
    title: 'Вопрос с прогнозом',
    what: 'вопрос про будущий год, например «Какую ставку выбрать на 2027 год».',
    read: 'агент покажет допущения (какие лимиты и выручку взял) и расчёт по трём ставкам.',
    todo: (_n, env) =>
      env.asked
        ? 'мы задали этот вопрос за вас. Допущения в строке «Понял так», расчёт ниже.'
        : 'допущения в строке «Понял так», расчёт ниже.',
    path: '/agent',
    targets: ['[data-tour="understood"]'],
    pick: 'last',
    prepare: 'chat-example',
  },
  {
    id: 'edit',
    chapter: 'agent',
    title: 'Изменить',
    what: 'строка «Понял так» показывает, как агент понял юрлицо, налог и период.',
    read: 'если понял не так, ответ будет про другое.',
    todo: 'нажмите «Изменить» и выберите нужное юрлицо, налог или период.',
    path: '/agent',
    targets: ['[data-tour="understood-edit"]', '[data-tour="understood"]'],
    pick: 'last',
    prepare: 'chat-example',
  },
  {
    id: 'quick',
    chapter: 'agent',
    title: 'Уточнения',
    what: 'кнопки под ответом.',
    read: 'каждая это тот же вопрос с поправкой, например «Рост +10%» или «Только Альфа».',
    todo: 'нажмите кнопку, и агент пересчитает.',
    path: '/agent',
    targets: ['[data-tour="quick"]'],
    pick: 'last',
    prepare: 'chat-example',
  },
  {
    id: 'answer-specialist',
    chapter: 'agent',
    title: 'Передать специалисту',
    what: 'кнопка под ответом: отправляет этот расчёт на проверку.',
    read: 'бухгалтер или финансовый директор получит цифры и допущения из ответа.',
    todo: 'нажмите кнопку, выберите человека и при желании напишите комментарий.',
    path: '/agent',
    targets: ['[data-tour="act-send"]'],
    pick: 'last',
    prepare: 'chat-example',
  },

  // ===== Дашборд =====
  {
    id: 'banner-revenue',
    chapter: 'dashboard',
    title: 'Выручка с начала года',
    what: (n) =>
      n ? `сколько группа заработала с 1 января по сегодня: ${n.revenue}.` : 'сколько группа заработала с 1 января по сегодня.',
    read: 'число растёт само, это живой счётчик.',
    todo: 'нажмите на баннер, чтобы увидеть выручку по каждому юрлицу.',
    path: '/dashboard',
    targets: ['[data-tour="banner-revenue"]'],
    mode: 'try',
  },
  {
    id: 'banner-vat',
    chapter: 'dashboard',
    title: 'НДС начислен',
    what: (n) =>
      n
        ? `налог, который уже набежал за этот год при выбранных ставках: ${n.vatAccrued}.`
        : 'налог, который уже набежал за этот год при выбранных ставках.',
    read: 'считается только по плательщикам НДС.',
    todo: 'откройте баннер и посмотрите, кто сколько должен.',
    path: '/dashboard',
    targets: ['[data-tour="banner-vat"]'],
    mode: 'try',
  },
  {
    id: 'banner-vat-forecast',
    chapter: 'dashboard',
    title: (n) => `НДС за ${yearOf(n)} год, прогноз`,
    what: (n) => (n ? `сколько НДС выйдет за весь год: ${n.vatForecast}.` : 'сколько НДС выйдет за весь год.'),
    read: (n) =>
      n
        ? `факт с 1 января плюс остаток с учётом сезонности (лето выше, зима ниже): ${n.vatSplit}.`
        : 'факт с 1 января плюс остаток с учётом сезонности (лето выше, зима ниже).',
    todo: 'сравните с «НДС начислен»: разница это то, что ещё предстоит.',
    path: '/dashboard',
    targets: ['[data-tour="banner-vat-forecast"]'],
    mode: 'try',
  },
  {
    id: 'banner-profit',
    chapter: 'dashboard',
    title: (n) => `Налог на прибыль за ${yearOf(n)} год`,
    what: (n) => {
      if (!n) return 'налог на прибыль юрлица на ОСНО за год и УСН по остальным юрлицам.';
      return n.osno
        ? `налог на прибыль ${n.osno} (ОСНО) за год, ${n.profit}, и УСН по остальным юрлицам, ${n.usn}.`
        : `УСН по группе за год: ${n.usn}.`;
    },
    read: 'тоже факт плюс прогноз остатка года.',
    todo: 'нажмите и посмотрите по юрлицам и месяцам. Авансы платятся 28 апреля, июля и октября.',
    path: '/dashboard',
    targets: ['[data-tour="banner-profit"]'],
    mode: 'try',
  },
  {
    id: 'warnings',
    chapter: 'dashboard',
    title: 'Предупреждения',
    what: (n) => {
      if (!n) return 'то, что требует внимания.';
      const base = `то, что требует внимания. Сейчас ${pluralWarnings(n.warningsTotal)}`;
      return n.warningsUrgent > 0 ? `${base}, срочных ${n.warningsUrgent}.` : `${base}.`;
    },
    read: '«Срочно» вверху, «Внимание» и «К сведению» ниже.',
    todo: 'нажмите на строку: там пояснение и что делать.',
    path: '/dashboard',
    targets: ['[data-tour="warning-first"]', '[data-tour="warnings-head"]'],
    mode: 'try',
  },
  {
    id: 'chart',
    chapter: 'dashboard',
    title: 'График',
    what: (n) =>
      n?.bestMonth
        ? `выручка группы по месяцам, цвет это юрлицо. Самый большой месяц: ${n.bestMonth.name}, ${n.bestMonth.value}.`
        : 'выручка группы по месяцам, цвет это юрлицо.',
    read: 'сплошные столбцы это факт, штриховка прогноз.',
    todo: 'нажмите на цвет, чтобы увидеть юрлицо за месяц, на месяц внизу, чтобы увидеть весь столбец.',
    path: '/dashboard',
    targets: ['[data-tour="chart"]'],
    mode: 'try',
  },
  {
    id: 'entity',
    chapter: 'dashboard',
    title: 'Карточка юрлица',
    what: 'статус юрлица: платит оно НДС или нет.',
    read: (n) =>
      n
        ? `«плательщик» платит НДС, «освобождён» не платит. Полоса показывает, как близко порог в ${n.threshold}.`
        : '«плательщик» платит НДС, «освобождён» не платит. Полоса показывает, как близко порог.',
    todo: (n) =>
      n?.exempt
        ? `следите за полосой у освобождённых: у ${n.exempt.name} выручка ${n.exempt.ytd} из ${n.exempt.limit}.`
        : 'следите за полосой у освобождённых.',
    path: '/dashboard',
    targets: ['[data-tour="entity-threshold"]', '[data-tour="entity"]'],
  },
  {
    id: 'rates',
    chapter: 'dashboard',
    title: 'Ставки',
    what: 'три варианта НДС: 5%, 7% и 22%.',
    read: 'зелёная выбрана сейчас, красные для сравнения, суммы растут в реальном времени.',
    todo: (n) =>
      n?.rates
        ? `сравните суммы: чем меньше число, тем выгоднее. Сейчас у ${n.rates.name}: ${n.rates.items
            .map((r) => `${r.rate}% ${r.sum}`)
            .join(', ')}.`
        : 'сравните суммы: чем меньше число, тем выгоднее.',
    path: '/dashboard',
    targets: ['[data-tour="rates"]'],
  },
  {
    id: 'tax-switch',
    chapter: 'dashboard',
    title: 'Выбор налога',
    what: 'переключатель вида налога в окне расчёта.',
    read: 'выбранный красный, остальные белые.',
    todo: 'нажмите «Налог на прибыль» или «Налог по УСН», чтобы увидеть расчёт по ним.',
    path: '/dashboard',
    targets: ['[data-tour="tax-switch"]'],
    prepare: 'calc-profit',
    mode: 'try',
  },
  {
    id: 'actions',
    chapter: 'dashboard',
    title: 'Кнопки под цифрой',
    what: 'четыре действия с расчётом.',
    read: '«Показать расчёт» формулы по шагам, «Выгрузить в Excel» файл с формулами. «Проверить самому» чеклист для сверки, «Передать специалисту» отправка на проверку.',
    todo: 'нажмите «Показать расчёт», чтобы увидеть, откуда цифра.',
    path: '/dashboard',
    targets: ['[data-tour="actions"]'],
  },
  {
    id: 'specialist',
    chapter: 'dashboard',
    title: 'Передать специалисту',
    what: 'отправка расчёта бухгалтеру или финансовому директору на проверку.',
    read: 'запрос уйдёт выбранному человеку, он ответит комментарием или согласованием.',
    todo: 'нажмите кнопку и выберите человека. Статус виден в меню, в «Статусах проверок».',
    path: '/dashboard',
    targets: ['[data-tour="act-send"]'],
  },

  // ===== Документы =====
  {
    id: 'doc-catalog',
    chapter: 'documents',
    title: 'Каталог',
    what: 'готовые шаблоны договоров, допсоглашений, отчётов и деклараций.',
    read: 'над списком фильтр по виду и поиск по названию.',
    todo: 'найдите нужный шаблон.',
    path: '/documents',
    targets: ['[data-tour="doc-catalog"]', '[data-tour="doc-tabs"]'],
  },
  {
    id: 'doc-fill',
    chapter: 'documents',
    title: 'Заполнить',
    what: 'кнопка у шаблона: из него получается ваш документ.',
    read: 'реквизиты юрлица и суммы из расчёта встанут сами.',
    todo: 'нажмите «Заполнить», выберите юрлицо и период.',
    path: '/documents',
    targets: ['[data-tour="doc-fill"]'],
  },
  {
    id: 'doc-bar',
    chapter: 'documents',
    title: 'Дозаполнить',
    what: 'панель внизу страницы документа: сколько пропусков осталось и что с ними делать.',
    read: 'счётчик «Не заполнено» нажимается и ведёт к первому пропуску, стрелки к следующему.',
    todo: 'нажмите «Дозаполнить»: форма покажет только пропущенные поля.',
    path: 'document',
    targets: ['[data-tour="doc-bar"]'],
  },
  {
    id: 'doc-menu',
    chapter: 'documents',
    title: 'Меню «ещё»',
    what: 'три точки у названия документа.',
    read: 'там «Скачать .docx», «Проверить самому», «История версий» и «Комментарии».',
    todo: 'нажмите, когда нужно скачать файл или сверить цифры.',
    path: 'document',
    targets: ['[data-tour="doc-menu"]'],
  },
  {
    id: 'doc-send',
    chapter: 'documents',
    title: 'Отправить',
    what: 'отправка документа на проверку бухгалтеру или финансовому директору.',
    read: 'кнопка включается, когда заполнены обязательные поля.',
    todo: 'заполните пропуски и нажмите «Отправить».',
    path: 'document',
    targets: ['[data-tour="doc-send"]'],
  },
  {
    id: 'doc-status',
    chapter: 'documents',
    title: 'Статусы и версии',
    what: 'строка под названием: номер версии и статус.',
    read: 'статус: черновик, на проверке, есть замечания, согласовано. Каждая правка создаёт новую версию, старые остаются.',
    todo: 'откройте «История версий» в меню «ещё», чтобы увидеть, что менялось.',
    path: 'document',
    targets: ['[data-tour="doc-meta"]'],
  },

  // ===== Меню =====
  {
    id: 'menu-lock',
    chapter: 'menu',
    title: 'Блокировка',
    what: 'кнопка «Заблокировать» в меню из трёх точек.',
    read: 'экран закроется и попросит PIN; сам он закрывается и после простоя.',
    todo: 'нажмите, когда отходите от экрана.',
    path: null,
    targets: ['[data-tour="menu-lock"]'],
    menu: true,
  },
  {
    id: 'menu-pin',
    chapter: 'menu',
    title: 'Смена PIN',
    what: 'PIN из четырёх цифр открывает приложение на этом устройстве.',
    read: 'на каждом устройстве свой PIN, после пяти ошибок вход только по паролю.',
    todo: 'нажмите «Сменить PIN», если его мог узнать посторонний. Обучение всегда в меню из трёх точек.',
    path: null,
    targets: ['[data-tour="menu-pin"]'],
    menu: true,
  },
];

/** Заголовок шага для числа. */
export function stepTitle(step: TourStep, n: TourNumbers | null): string {
  return typeof step.title === 'function' ? step.title(n) : step.title;
}

/** Три строки шага с метками, числа подставлены. Первая буква строки заглавная не нужна: после двоеточия. */
export function stepLines(
  step: TourStep,
  n: TourNumbers | null,
  env: TourEnv = { asked: false },
): { key: 'what' | 'read' | 'todo'; label: string; text: string }[] {
  return LINE_LABELS.map(({ key, label }) => {
    const line = step[key];
    return { key, label, text: typeof line === 'function' ? line(n, env) : line };
  });
}

/** Селекторы data-tour, на которые ссылаются шаги: по ним тест проверяет, что элементы есть. */
export function tourAttributes(): string[] {
  const out = new Set<string>();
  for (const s of TOUR_STEPS) {
    for (const t of s.targets) {
      const m = /\[data-tour="([^"]+)"\]/.exec(t);
      if (m) out.add(m[1]!);
    }
  }
  return [...out];
}

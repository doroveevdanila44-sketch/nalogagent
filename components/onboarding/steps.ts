/**
 * Шаги обучения. Шесть шагов, на каждом подсвечивается свой элемент интерфейса. Подсказка к шагу:
 * заголовок и одна-две короткие строки. Тексты без длинных тире.
 *
 * targets: селекторы по порядку, берётся первый видимый элемент. Вкладки разделов подсвечиваются
 * там, где они стоят: на телефоне это нижняя панель, на компьютере боковая (одни и те же ссылки).
 * path: страница, на которой шаг показан; null значит «там, где человек сейчас».
 */

export interface TourStep {
  id: 'agent' | 'dashboard' | 'rates' | 'documents' | 'sources' | 'menu';
  title: string;
  lines: string[];
  path: '/dashboard' | null;
  targets: string[];
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'agent',
    title: 'Агент',
    lines: ['Спросите про налог своими словами.', 'Укажите юрлицо и период.'],
    path: null,
    targets: ['nav.tabs a[href="/agent"]'],
  },
  {
    id: 'dashboard',
    title: 'Дашборд',
    lines: ['Четыре баннера группы.', 'Нажмите на баннер, чтобы увидеть детали.'],
    path: '/dashboard',
    targets: ['.sum-cards'],
  },
  {
    id: 'rates',
    title: 'Ставки',
    lines: ['Выбранная ставка одна.', 'Остальные показаны для сравнения.'],
    path: '/dashboard',
    targets: ['.rates:not(.single)', '.rates'],
  },
  {
    id: 'documents',
    title: 'Документы',
    lines: ['Заполните шаблон, откройте файл', 'и отправьте его на проверку.'],
    path: null,
    targets: ['nav.tabs a[href="/documents"]'],
  },
  {
    id: 'sources',
    title: 'Откуда цифры',
    lines: ['У сумм есть источник.', 'Кнопка «Показать расчёт» раскрывает шаги.'],
    path: '/dashboard',
    targets: ['[data-testid="source-line"]'],
  },
  {
    id: 'menu',
    title: 'Меню',
    lines: ['Блокировка и смена PIN.', 'Здесь же можно пересмотреть обучение.'],
    path: null,
    targets: ['header.top button[aria-label="Меню"]'],
  },
];

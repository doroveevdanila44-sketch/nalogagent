/** Типы ответов API действий: общие для сервера и интерфейса, без серверных зависимостей. */

export const REVIEW_STATUS_LABEL: Record<string, string> = {
  sent: 'Отправлено на проверку',
  in_review: 'На проверке',
  confirmed: 'Проверено',
  returned: 'Возвращено с замечаниями',
};

export interface Person {
  id: string;
  name: string;
  role: string;
}

export interface ReviewItem {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  comment: string;
  recipient: Person;
  /** Итоги расчётов запроса на момент отправки */
  totals: { label: string; total: string | null }[];
  excelName: string;
  createdAt: string;
  demo: true;
}

export interface CheckMark {
  item: string;
  amount: string | null;
  checkedAt: string;
}


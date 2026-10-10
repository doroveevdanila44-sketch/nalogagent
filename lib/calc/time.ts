/**
 * Момент времени в «стенных часах» часового пояса приложения (APP_TZ).
 * Калькулятор не зависит от пояса машины: одни и те же вход и момент дают один и тот же результат
 * на сервере Vercel (UTC), в браузере и в тестах.
 */
export interface Moment {
  year: number;
  /** 0..11 */
  month: number;
  /** 1..31 */
  day: number;
  /** 0..86400, дробная часть это миллисекунды */
  secondsOfDay: number;
}

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function momentFromEpoch(epochMs: number, tz: string): Moment {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const ms = ((epochMs % 1000) + 1000) % 1000;
  const seconds = pick('hour') * 3600 + pick('minute') * 60 + pick('second') + ms / 1000;
  return { year: pick('year'), month: pick('month') - 1, day: pick('day'), secondsOfDay: seconds };
}

/** Удобный конструктор для тестов и сидов: moment(2026, 10, 10, 12, 0, 0), месяц 1..12. */
export function moment(year: number, month1: number, day: number, h = 0, m = 0, s = 0): Moment {
  return { year, month: month1 - 1, day, secondsOfDay: h * 3600 + m * 60 + s };
}

export function addDay(d: CalendarDay): CalendarDay {
  const t = new Date(Date.UTC(d.year, d.month, d.day + 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate() };
}

export function compareDays(a: CalendarDay, b: CalendarDay): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function toIsoDate(d: CalendarDay): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.year}-${p(d.month + 1)}-${p(d.day)}`;
}

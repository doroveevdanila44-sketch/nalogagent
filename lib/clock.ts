/**
 * Часы расчётов. В работе это Date.now(). Для проверки экранов на выбранную дату (аудит сроков,
 * e2e/dates.spec.ts) сервер можно запустить с двумя переменными сразу:
 *   PVA_FAKE_NOW=2026-10-29T09:00:00Z  PVA_ALLOW_FAKE_NOW=1
 * Время тогда идёт от заданного момента с той же скоростью. Без второй переменной первая
 * игнорируется, поэтому случайно заданная PVA_FAKE_NOW в рабочей среде ничего не меняет.
 * Входом, сессиями, PIN и паролем часы не управляют: они берут настоящее время.
 */
const STARTED = Date.now();

export function appNow(): number {
  const fake = process.env.PVA_FAKE_NOW;
  if (fake && process.env.PVA_ALLOW_FAKE_NOW === '1') {
    const t = Date.parse(fake);
    if (Number.isFinite(t)) return t + (Date.now() - STARTED);
  }
  return Date.now();
}

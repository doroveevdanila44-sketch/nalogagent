/**
 * Остановка «живых» цифр дашборда. Пока открыта панель расчёта, экран проверки или окно передачи,
 * секундный тик дашборда стоит: цифры под окном остаются теми, по которым посчитан расчёт, и
 * совпадают с ним до копейки. После закрытия окна тик продолжается со следующей секунды.
 */
let held = 0;

export const LIVE_HOLD_EVENT = 'pva:live-hold';

export function isLiveHeld(): boolean {
  return held > 0;
}

/** Берёт остановку; возвращает функцию, которая её отпускает. */
export function holdLive(): () => void {
  held += 1;
  window.dispatchEvent(new CustomEvent(LIVE_HOLD_EVENT, { detail: { held } }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held = Math.max(0, held - 1);
    window.dispatchEvent(new CustomEvent(LIVE_HOLD_EVENT, { detail: { held } }));
  };
}

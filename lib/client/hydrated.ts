import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * false на сервере и до гидратации, true после. Клавиши PIN и кнопка входа неактивны, пока
 * страница не ожила: иначе клик по серверной разметке пропадает или отправляет форму нативно.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

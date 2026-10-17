'use client';

import { useKeyboardViewport } from '@/lib/client/use-keyboard-viewport';

/**
 * Подключает хук экранной клавиатуры на всю страницу, включая вход и PIN: --vvh, --kb и --vv-top на
 * <html> нужны любому экрану, где есть поле ввода. Ничего не рисует.
 */
export function KeyboardViewport() {
  useKeyboardViewport();
  return null;
}

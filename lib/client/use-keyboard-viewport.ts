'use client';

import { useEffect } from 'react';
import { watchKeyboard } from './keyboard';

/**
 * Хук: слушает window.visualViewport (resize и scroll), фокус и размер окна и пишет высоту видимой
 * области в --vvh, высоту клавиатуры в --kb и сдвиг видимой области в --vv-top на <html>. При
 * размонтировании подписки снимаются, переменные удаляются. Подробности в keyboard.ts.
 */
export function useKeyboardViewport(): void {
  useEffect(() => watchKeyboard(), []);
}

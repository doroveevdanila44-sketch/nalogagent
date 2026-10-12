/**
 * iPhone и iPad. Новые iPad в режиме «как на компьютере» называют себя Macintosh, их выдаёт
 * касание (у Mac с мышью точек касания нет).
 */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

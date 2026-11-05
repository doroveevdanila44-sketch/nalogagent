/**
 * Знак РОБОРАБ живым текстом: Montserrat Black Italic, прописные (docs/DESIGN.md, 10.3). Название
 * клиента в шапке и на экранах входа не пишется. Стили знака в app/globals.css (.wordmark).
 */
export function Wordmark({
  big = false,
  size,
}: {
  big?: boolean;
  /** small: около 20 px на экране PIN, big: 30 px на экране пароля */
  size?: 'small' | 'normal' | 'big';
  /** Оставлено для совместимости вызовов: знак всегда белый, шапка и экраны входа фиолетовые */
  tone?: 'header' | 'light';
}) {
  const sz = size ?? (big ? 'big' : 'normal');
  return (
    <div className={`wordmark ${sz === 'big' ? 'big' : ''} ${sz === 'small' ? 'small' : ''}`} role="img" aria-label="РОБОРАБ">
      <span aria-hidden="true">РОБОРАБ</span>
    </div>
  );
}

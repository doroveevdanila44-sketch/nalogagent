import { sourceLineText, type SourceLineData } from '@/lib/provenance/line';

/**
 * Строка происхождения под итоговой суммой: «1С (демо) · обновлено 10.10, 18:00 · факт и прогноз».
 * Мелким шрифтом, переносится в одну-две строки на телефоне. Юрлицо и период в ней не повторяются:
 * они в заголовке рядом. Метки «Демо-данные» здесь нет, она один раз в шапке. Внутри кнопки (баннер)
 * рисуется как span, иначе как абзац.
 */
export function SourceLine({
  data,
  tone = 'light',
  inline = false,
}: {
  data: SourceLineData | null | undefined;
  tone?: 'light' | 'dark';
  /** Внутри кнопки или другого строчного контейнера */
  inline?: boolean;
}) {
  if (!data) return null;
  const cls = `src-line${tone === 'dark' ? ' on-dark' : ''}`;
  const body = <span className="src-text">{sourceLineText(data)}</span>;
  return inline ? (
    <span className={cls} data-testid="source-line">
      {body}
    </span>
  ) : (
    <p className={cls} data-testid="source-line">
      {body}
    </p>
  );
}

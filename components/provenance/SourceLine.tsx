import { DEMO_LABEL, sourceLineText, type SourceLineData } from '@/lib/provenance/line';

/**
 * Строка происхождения под итоговой суммой: метка «Демо-данные» и текст
 * «Выгрузка из 1С (демо) · ООО «Альфа» · февраль 2026 · обновлено 10.10.2026 18:00 · факт».
 * Мелким шрифтом, переносится в одну-две строки на телефоне. Внутри кнопки (баннер) рисуется
 * как span, иначе как абзац.
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
  const body = (
    <>
      <span className="demo-chip">{DEMO_LABEL}</span> <span className="src-text">{sourceLineText(data)}</span>
    </>
  );
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

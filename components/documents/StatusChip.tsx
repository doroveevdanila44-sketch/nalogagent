import { STATUS_LABEL, type DocStatus } from '@/lib/documents/types';

const GLYPH: Record<DocStatus, string> = {
  draft: '○',
  review: '◐',
  remarks: '▲',
  approved: '✓',
  withdrawn: '✕',
};

/**
 * Статус документа: слово и знак, не только цвет. compact: маленькая метка внутри строки
 * «Версия 1 · черновик · обновлён 12.10, 11:54».
 */
export function StatusChip({ status, compact = false }: { status: DocStatus; compact?: boolean }) {
  return (
    <span className={`doc-status st-${status}${compact ? ' sm' : ''}`} data-status={status}>
      <span aria-hidden="true">{GLYPH[status]}</span> {STATUS_LABEL[status]}
    </span>
  );
}

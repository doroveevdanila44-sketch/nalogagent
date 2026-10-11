import { STATUS_LABEL, type DocStatus } from '@/lib/documents/types';

const GLYPH: Record<DocStatus, string> = {
  draft: '○',
  review: '◐',
  remarks: '▲',
  approved: '✓',
  withdrawn: '✕',
};

/** Статус документа: слово и знак, не только цвет. */
export function StatusChip({ status }: { status: DocStatus }) {
  return (
    <span className={`doc-status st-${status}`} data-status={status}>
      <span aria-hidden="true">{GLYPH[status]}</span> {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Значок файла: лист с загнутым углом и полоса с расширением. .docx на озере, .xlsx на лимонном:
 * тип отличается и подписью, и цветом полосы.
 */
export function FileIcon({ kind }: { kind: 'docx' | 'xlsx' }) {
  return (
    <svg className={`file-ic file-ic-${kind}`} viewBox="0 0 44 52" aria-hidden="true" focusable="false">
      <path className="file-ic-page" d="M7 3h20l12 12v32a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path className="file-ic-fold" d="M27 3v12h12" />
      <path className="file-ic-band" d="M5 31h34v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
      <text className="file-ic-ext" x="22" y="43" textAnchor="middle">
        {kind.toUpperCase()}
      </text>
    </svg>
  );
}

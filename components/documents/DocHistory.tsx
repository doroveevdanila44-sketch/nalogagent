'use client';

import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import type { DocumentDetail } from '@/lib/documents/detail';
import { STATUS_LABEL, type EventInfo } from '@/lib/documents/types';
import { shortDateTime } from '@/lib/provenance/line';

const EVENT_TEXT: Record<string, (e: EventInfo) => string> = {
  created: () => 'Документ создан из шаблона',
  version: (e) => {
    const n = Number(e.data.changes ?? 0);
    return `Новая версия ${e.versionN}: изменений ${n}`;
  },
  submitted: (e) => `Отправлен на проверку: ${String(e.data.recipient ?? '')}`,
  withdrawn: () => 'Документ отозван',
  comment: (e) => `Комментарий: ${String(e.data.text ?? '')}`,
  remark: (e) => `Замечание (демо): ${String(e.data.text ?? '')}`,
  approval: (e) => `Согласовано (демо): ${String(e.data.text ?? '')}`,
  resolved: () => 'Комментарий отмечен решённым',
};

/**
 * «История версий»: версии с изменениями и контрольной суммой, любую можно открыть (старую версию
 * править нельзя), и лента событий: создание, правки, отправка, ответы, согласование, отзыв.
 */
export function DocHistory({
  doc,
  onOpenVersion,
  onClose,
}: {
  doc: DocumentDetail;
  onOpenVersion: (n: number) => void;
  onClose: () => void;
}) {
  return (
    <Overlay kind="drawer" label="История версий" onClose={onClose}>
      <OverlayHead title="История версий" onClose={onClose} />
      <div className="ov-scroll">
        <h3 className="hist-h">Версии ({doc.versions.length})</h3>
        <ol className="ver-list" data-testid="versions">
          {doc.versions.map((v) => {
            // создание документа есть в событиях с той же датой: в версии оно не повторяется
            const changes = v.changes.filter((c) => c.field !== 'created');
            return (
              <li key={v.n} className={v.n === doc.shownVersion ? 'on' : ''}>
                <div className="ver-head">
                  <b>Версия {v.n}</b>
                  {v.n === doc.version ? <span className="ver-now">нынешняя</span> : null}
                </div>
                <small>
                  {v.authorName}, {shortDateTime(Date.parse(v.createdAt), doc.tz)}
                </small>
                {changes.length > 0 ? (
                  <ul className="ver-changes">
                    {changes.map((c, i) => (
                      <li key={i}>
                        {c.field === 'calc' ? (
                          c.label
                        ) : (
                          <>
                            {c.label}: {c.from ?? 'пусто'} → {c.to ?? 'пусто'}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <small className="ver-hash" title={v.hash}>
                  контрольная сумма {v.hash.slice(0, 12)}
                </small>
                {v.n !== doc.shownVersion ? (
                  <button type="button" className="linkish" onClick={() => onOpenVersion(v.n)}>
                    Открыть версию {v.n}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>

        <h3 className="hist-h">События ({doc.events.length})</h3>
        <ol className="ev-list" data-testid="events">
          {doc.events.map((e) => (
            <li key={e.id} data-event={e.kind}>
              <small>{shortDateTime(Date.parse(e.createdAt), doc.tz)}</small>
              <span>
                <b>{e.actor}</b>: {(EVENT_TEXT[e.kind] ?? (() => e.kind))(e)}
                {e.kind === 'version' && e.data.toStatus
                  ? ` · статус: ${STATUS_LABEL[e.data.toStatus as keyof typeof STATUS_LABEL] ?? ''}`
                  : ''}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Overlay>
  );
}

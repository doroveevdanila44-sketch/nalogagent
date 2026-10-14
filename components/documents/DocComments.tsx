'use client';

import { useMemo, useState } from 'react';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import type { DocumentDetail } from '@/lib/documents/detail';
import { dateTimeWithZone } from '@/lib/provenance/line';

/**
 * «Комментарии»: список с пометкой «решено» и форма нового комментария к документу целиком или к
 * полю. Имитированные ответы бухгалтера подписаны «имитация» в самом комментарии.
 */
export function DocComments({
  doc,
  busy,
  onAdd,
  onResolve,
  onClose,
}: {
  doc: DocumentDetail;
  busy: string | null;
  /** true: комментарий добавлен, поле очищается */
  onAdd: (fieldKey: string | null, body: string) => Promise<boolean>;
  onResolve: (commentId: number, resolved: boolean) => void;
  onClose: () => void;
}) {
  const [field, setField] = useState('');
  const [text, setText] = useState('');
  const fieldLabel = useMemo(() => new Map(doc.fields.map((f) => [f.key, f.label])), [doc.fields]);
  const unresolved = doc.comments.filter((c) => !c.resolved).length;

  return (
    <Overlay kind="drawer" label="Комментарии" onClose={onClose}>
      <OverlayHead
        title="Комментарии"
        sub={doc.comments.length === 0 ? undefined : `Всего ${doc.comments.length}, без решения ${unresolved}`}
        onClose={onClose}
      />
      <div className="ov-scroll">
        {doc.comments.length === 0 ? <p className="calc-note">Комментариев пока нет.</p> : null}
        <ul className="cm-list" data-testid="comments">
          {doc.comments.map((c) => (
            <li key={c.id} className={`cm cm-${c.kind}${c.resolved ? ' resolved' : ''}`}>
              <div className="cm-head">
                <b>{c.authorName}</b>
                <span className="cm-kind">
                  {c.kind === 'remark' ? 'Замечание' : c.kind === 'approval' ? 'Согласование' : 'Комментарий'}
                  {c.isDemo ? ' · имитация' : ''}
                </span>
              </div>
              <p>{c.body}</p>
              <small>
                {dateTimeWithZone(Date.parse(c.createdAt), doc.tz)}, версия {c.versionN}
                {c.fieldKey ? ` · ${fieldLabel.get(c.fieldKey) ?? 'абзац'}` : ''}
                {c.resolved ? ' · решено' : ''}
              </small>
              {c.kind !== 'approval' ? (
                <button
                  type="button"
                  className="act cm-resolve"
                  data-action="resolve"
                  disabled={busy === `res-${c.id}`}
                  onClick={() => onResolve(c.id, !c.resolved)}
                >
                  {c.resolved ? 'Снять отметку «решено»' : 'Отметить решённым'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>

        <form
          className="cm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd(field === '' ? null : field, text).then((ok) => {
              if (ok) setText('');
            });
          }}
        >
          <label className="fld">
            <span>К чему комментарий</span>
            <select aria-label="К чему комментарий" value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">К документу целиком</option>
              {doc.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span>Комментарий</span>
            <textarea
              aria-label="Комментарий"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Что нужно проверить или уточнить"
            />
          </label>
          <button type="submit" className="act" data-action="comment" disabled={busy === 'comment' || text.trim() === ''}>
            Добавить комментарий
          </button>
        </form>
      </div>
    </Overlay>
  );
}

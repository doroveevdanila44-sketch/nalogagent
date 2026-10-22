import type { ChangeOptions, ChatTurn, FleetForm, QuickReply, Slot, Table, Understanding } from './types';

/**
 * Сохранённые ответы читаются из базы, а разметка чата рассчитывает на нынешний вид каждого поля.
 * Ответ, записанный прежней версией (нет списка допущений у карточки «Понял так», пустая ячейка
 * таблицы, кнопка без текста), раньше ронял всю вкладку «Агент»: чат разворачивал поле и спотыкался.
 * Здесь каждое поле приводится к виду, который разметка точно разберёт: целое и верное остаётся как
 * есть, недостающее восполняется (список допущений пуст), негодное отбрасывается. Ничего не бросает.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const SLOTS: readonly Slot[] = ['entity', 'tax', 'period'];

export function cleanHow(v: unknown): string[] {
  return strings(v);
}

export function cleanTables(v: unknown): Table[] {
  if (!Array.isArray(v)) return [];
  const out: Table[] = [];
  for (const t of v) {
    if (!isObj(t) || !Array.isArray(t.head) || !Array.isArray(t.rows)) continue;
    const table: Table = {
      head: strings(t.head),
      rows: t.rows.filter(Array.isArray).map((row) => row.map((c) => (isStr(c) ? c : c == null ? '' : String(c)))),
    };
    if (Array.isArray(t.best)) {
      table.best = t.best.filter(
        (p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isInteger(n)),
      );
    }
    if (typeof t.totalRow === 'boolean') table.totalRow = t.totalRow;
    if (typeof t.dense === 'boolean') table.dense = t.dense;
    out.push(table);
  }
  return out;
}

export function cleanQuick(v: unknown): QuickReply[] {
  if (!Array.isArray(v)) return [];
  const out: QuickReply[] = [];
  for (const q of v) {
    if (!isObj(q) || !isStr(q.label) || !isStr(q.text)) continue;
    const reply: QuickReply = { label: q.label, text: q.text };
    if (SLOTS.includes(q.group as Slot)) reply.group = q.group as Slot;
    out.push(reply);
  }
  return out;
}

export function cleanUnderstood(v: unknown): Understanding | null {
  if (!isObj(v) || !isStr(v.entity) || !isStr(v.tax) || !isStr(v.period) || !isStr(v.kindLabel)) return null;
  return { ...(v as unknown as Understanding), notes: strings(v.notes) };
}

export function cleanChange(v: unknown): ChangeOptions | null {
  if (!isObj(v)) return null;
  return { entity: cleanQuick(v.entity), tax: cleanQuick(v.tax), period: cleanQuick(v.period) };
}

export function cleanForm(v: unknown): FleetForm | null {
  if (!isObj(v) || (v.mode !== 'ask' && v.mode !== 'edit') || !isObj(v.values)) return null;
  if (!Array.isArray(v.entities) || !Array.isArray(v.months) || !Array.isArray(v.missing)) return null;
  if (!isObj(v.quick) || !Array.isArray(v.quick.cost) || !Array.isArray(v.quick.rent)) return null;
  return v as unknown as FleetForm;
}

export function cleanProvenance(v: unknown): ChatTurn['provenance'] {
  return isObj(v) && isObj(v.line) ? (v as unknown as ChatTurn['provenance']) : null;
}

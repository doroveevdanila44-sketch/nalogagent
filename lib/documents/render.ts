import { dec } from '@/lib/calc/decimal';
import { rub2 } from '@/lib/calc/format';
import { KIND_LABEL } from '@/lib/provenance/line';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';
import type { FieldSource, FieldType, FieldValues, TemplateField } from './types';

/**
 * Разбор тела шаблона в блоки для .docx и .xlsx. Тело: «# » и «## » заголовки,
 * «- » пункт списка, остальные строки абзацы, {{поле}} подстановка, строка {{table:months}} или
 * {{table:entities}} таблица из расчёта. Одно и то же дерево блоков строит оба файла, поэтому
 * суммы в них совпадают.
 */

export type Seg =
  | { t: 'text'; text: string }
  | {
      t: 'field';
      key: string;
      label: string;
      state: 'filled' | 'missing';
      source: FieldSource;
      type: FieldType;
      /** Текст поля; у пропущенного подпись в скобках */
      text: string;
      /** Точное значение (деньги и проценты строкой); null у пропущенного */
      value: string | null;
      /** Номер снимка расчёта для значка «Показать расчёт» */
      calcIndex: number | null;
    };

export interface TableCell {
  text: string;
  /** Сумма из расчёта: у неё значок «Показать расчёт» */
  money?: boolean;
  /** Точное значение суммы строкой */
  amount?: string;
}

export type RenderBlock =
  | { id: string; kind: 'h1' | 'h2' | 'p' | 'li'; segs: Seg[] }
  | {
      id: string;
      kind: 'table';
      table: 'months' | 'entities';
      head: string[];
      rows: TableCell[][];
      calcIndex: number | null;
    };

const FIELD_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
const TABLE_RE = /^\{\{\s*table:(months|entities)\s*\}\}$/;

function segments(line: string, fields: Map<string, TemplateField>, values: FieldValues): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of line.matchAll(FIELD_RE)) {
    if (m.index! > last) out.push({ t: 'text', text: line.slice(last, m.index) });
    const key = m[1]!;
    const f = fields.get(key);
    const v = values[key];
    if (!f) {
      out.push({ t: 'text', text: m[0] });
    } else if (v?.value) {
      out.push({
        t: 'field',
        key,
        label: f.label,
        state: 'filled',
        source: v.source,
        type: f.type,
        text: v.display ?? v.value,
        value: v.value,
        calcIndex: v.source === 'calc' && f.type === 'money' ? (v.calc?.index ?? null) : null,
      });
    } else {
      out.push({
        t: 'field',
        key,
        label: f.label,
        state: 'missing',
        source: f.source,
        type: f.type,
        text: `[${f.label}]`,
        value: null,
        calcIndex: null,
      });
    }
    last = m.index! + m[0].length;
  }
  if (last < line.length) out.push({ t: 'text', text: line.slice(last) });
  return out;
}

const BASIS = { fact: 'факт', partial: 'идёт', forecast: 'прогноз' } as const;

function tableFor(
  kind: 'months' | 'entities',
  snaps: CalcSnapshot[],
  scope: 'entity' | 'group',
): { head: string[]; rows: TableCell[][]; calcIndex: number | null } {
  const s = snaps[0];
  if (!s) return { head: ['Нет данных расчёта'], rows: [], calcIndex: null };
  const money = (v: string | null): TableCell =>
    v === null ? { text: 'нет данных' } : { text: rub2(dec(v)), money: true, amount: v };
  if (kind === 'months') {
    const own = scope === 'entity' ? s.entities.find((e) => e.applicable) : undefined;
    const rows = own
      ? own.months.map((m) => [
          { text: m.label },
          { text: m.exempt ? 'освобождено' : m.basis === null ? 'нет данных' : m.status === 'partial' ? 'идёт' : BASIS[m.basis === 'fact' ? 'fact' : 'forecast'] },
          money(m.revenue),
          money(m.tax),
        ])
      : s.months.map((m) => [{ text: m.label }, { text: BASIS[m.status] }, money(m.revenue), money(m.tax)]);
    return { head: ['Месяц', 'Основа', 'Выручка с НДС', s.taxName], rows, calcIndex: 0 };
  }
  const rows: TableCell[][] = s.entities
    .filter((e) => e.applicable)
    .map((e) => [
      { text: e.name },
      { text: e.rate === null ? '' : `${e.rate}%` },
      money(e.revenue),
      money(e.tax),
    ]);
  rows.push([{ text: 'Итого' }, { text: '' }, money(s.revenue), money(s.total)]);
  return { head: ['Юрлицо', 'Ставка НДС', 'Выручка с НДС', s.taxName], rows, calcIndex: 0 };
}

export function renderBlocks(
  body: string,
  fields: TemplateField[],
  values: FieldValues,
  snaps: CalcSnapshot[],
  scope: 'entity' | 'group',
): RenderBlock[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const blocks: RenderBlock[] = [];
  body.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line.trim() === '') return;
    const id = `b${i}`;
    const t = TABLE_RE.exec(line.trim());
    if (t) {
      const kind = t[1] as 'months' | 'entities';
      blocks.push({ id, kind: 'table', table: kind, ...tableFor(kind, snaps, scope) });
    } else if (line.startsWith('## ')) {
      blocks.push({ id, kind: 'h2', segs: segments(line.slice(3), byKey, values) });
    } else if (line.startsWith('# ')) {
      blocks.push({ id, kind: 'h1', segs: segments(line.slice(2), byKey, values) });
    } else if (line.startsWith('- ')) {
      blocks.push({ id, kind: 'li', segs: segments(line.slice(2), byKey, values) });
    } else {
      blocks.push({ id, kind: 'p', segs: segments(line, byKey, values) });
    }
  });
  return blocks;
}

/** Текст блока без разметки (для файлов и проверки). Пропущенное поле в скобках. */
export function segsText(segs: Seg[]): string {
  return segs.map((s) => (s.t === 'text' ? s.text : s.text)).join('');
}

/** Основа расчёта документа: «факт», «прогноз», «факт и прогноз». */
export function kindOf(snaps: CalcSnapshot[]): string | null {
  const s = snaps[0];
  return s ? KIND_LABEL[s.kind] : null;
}

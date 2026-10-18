import { dec } from '@/lib/calc/decimal';
import { dateRuYear, rub2 } from '@/lib/calc/format';
import { daysInMonth } from '@/lib/calc/time';
import { formatLoadedAt } from '@/lib/calc/provenance';
import { KIND_LABEL } from '@/lib/provenance/line';
import type { CalcQuery } from '@/lib/provenance/query';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';
import type { Period } from '@/lib/calc/period';
import type {
  EntityKey,
  EntityRequisites,
  FieldType,
  FieldValue,
  FieldValues,
  TemplateDef,
  TemplateField,
} from './types';

/**
 * Заполнение шаблона. Реквизиты берутся из справочника юрлица, суммы, ставки и даты расчёта только
 * из снимков calcTax, остальное вводит человек. Языковая модель в этом модуле не участвует: суммы
 * она не пишет и не подставляет.
 */

export interface EntityData {
  id: string;
  name: string;
  form: string;
  requisites: EntityRequisites | null;
}

const ENTITY_VALUE: Record<EntityKey, (e: EntityData) => string | undefined> = {
  name: (e) => e.name,
  form: (e) => e.form,
  inn: (e) => e.requisites?.inn,
  kpp: (e) => e.requisites?.kpp,
  ogrn: (e) => e.requisites?.ogrn,
  address: (e) => e.requisites?.address,
  signer_name: (e) => e.requisites?.signerName,
  signer_position: (e) => e.requisites?.signerPosition,
  bank: (e) => e.requisites?.bank,
  bik: (e) => e.requisites?.bik,
  account: (e) => e.requisites?.account,
  corr_account: (e) => e.requisites?.corrAccount,
  email: (e) => e.requisites?.email,
  phone: (e) => e.requisites?.phone,
};

/** Запросы расчёта, нужные шаблону: по одному на каждый налог его расчётных полей и таблиц. */
export function templateQueries(
  t: Pick<TemplateDef, 'fields' | 'taxes' | 'scope' | 'needsPeriod'>,
  args: { entityId: string | null; period: Period | null },
): CalcQuery[] {
  const taxes = new Set<CalcQuery['tax']>();
  for (const f of t.fields) if (f.source === 'calc' && f.calc) taxes.add(f.calc.tax);
  for (const tax of t.taxes) taxes.add(tax);
  const period: Period = t.needsPeriod && args.period ? args.period : { kind: 'ytd' };
  const entityIds = t.scope === 'entity' && args.entityId ? [args.entityId] : 'all';
  return [...taxes].map((tax) => ({ tax, period, entityIds }));
}

/** Как значение показано в документе. */
export function displayValue(type: FieldType, value: string): string {
  switch (type) {
    case 'money':
      return rub2(dec(value));
    case 'percent':
      return `${dec(value).toString()}%`;
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!m) return value;
      return `${dateRuYear({ year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) })} г.`;
    }
    default:
      return value;
  }
}

export class FieldError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = 'FieldError';
  }
}

/**
 * Символы, которых нет в XML 1.0 (управляющие кроме табуляции и переносов, U+FFFE, U+FFFF, одиночные
 * половинки суррогатной пары), и NUL, который не принимает Postgres. Они попадают в текст при вставке из
 * PDF и чужих программ; с ними .docx получался бы повреждённым, а запись версии падала. Убираются при вводе.
 */
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const cleanText = (raw: string): string => raw.replace(XML_INVALID, '');

/**
 * Приводит введённое вручную значение к виду поля. Деньги и числа принимаются с запятой и
 * пробелами, дата строго ГГГГ-ММ-ДД. Пустая строка означает «нет значения».
 */
export function normalizeInput(f: TemplateField, raw: string): string | null {
  const text = cleanText(raw).replace(/\r\n/g, '\n').trim();
  if (text === '') return null;
  switch (f.type) {
    case 'money': {
      const n = text.replace(/[\s ]/g, '').replace(',', '.').replace(/₽$/, '');
      if (!/^\d{1,12}(\.\d{1,2})?$/.test(n)) throw new FieldError(f.key, `${f.label}: нужна сумма, например 5000 или 5000,50`);
      return dec(n).toFixed(2);
    }
    case 'number': {
      if (!/^\d{1,6}$/.test(text)) throw new FieldError(f.key, `${f.label}: нужно целое число`);
      return text;
    }
    case 'percent': {
      const n = text.replace(',', '.').replace(/%$/, '');
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(n)) throw new FieldError(f.key, `${f.label}: нужен процент`);
      return n;
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      // существующая дата календаря: 30 февраля и 31 апреля не проходят (Date.parse переносил их на март и май)
      const ok =
        m &&
        Number(m[1]) >= 1900 &&
        Number(m[2]) >= 1 &&
        Number(m[2]) <= 12 &&
        Number(m[3]) >= 1 &&
        Number(m[3]) <= daysInMonth(Number(m[1]), Number(m[2]) - 1);
      if (!ok) throw new FieldError(f.key, `${f.label}: нужна существующая дата ГГГГ-ММ-ДД`);
      return text;
    }
    case 'longtext':
      if (text.length > 2000) throw new FieldError(f.key, `${f.label}: не длиннее 2000 знаков`);
      return text;
    default:
      if (text.length > 300) throw new FieldError(f.key, `${f.label}: не длиннее 300 знаков`);
      return text.replace(/\n+/g, ' ');
  }
}

function fromCalc(f: TemplateField, snaps: CalcSnapshot[]): FieldValue {
  const none: FieldValue = { value: null, display: null, source: 'calc' };
  const c = f.calc!;
  const index = snaps.findIndex((s) => s.tax === c.tax);
  const s = snaps[index];
  if (!s) return none;
  const mk = (value: string | null, step: string | null): FieldValue =>
    value === null || value === ''
      ? none
      : { value, display: displayValue(f.type, value), source: 'calc', calc: { index, step } };
  switch (c.metric) {
    case 'total':
      return mk(s.total, s.totalStep);
    case 'revenue':
      return mk(s.revenue, s.revenueStep);
    case 'rate': {
      const own = s.entities.filter((e) => e.applicable && e.rate !== null);
      const rate = own.length > 0 ? own[0]!.rate : s.rate;
      return mk(rate === null || rate === undefined ? null : String(rate), null);
    }
    case 'period':
      return mk(s.periodLabel, null);
    case 'asof':
      return mk(s.asOf, null);
    case 'kind':
      return mk(KIND_LABEL[s.kind], null);
    case 'source':
      return mk(s.source ? `${s.source.title}, загружена ${formatLoadedAt(s.source.loadedAt, s.tz)}` : null, null);
  }
}

/**
 * Значения всех полей шаблона. user: введённое вручную (ключ → строка). Поле реквизита, которого
 * нет в справочнике, можно ввести вручную: оно получит источник «введено вручную».
 */
export function fillFields(
  fields: TemplateField[],
  args: { entity: EntityData | null; snaps: CalcSnapshot[]; user: Record<string, string> },
): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    let v: FieldValue;
    if (f.source === 'calc') {
      v = fromCalc(f, args.snaps);
    } else {
      const typed = f.key in args.user ? normalizeInput(f, args.user[f.key] ?? '') : null;
      if (f.source === 'entity' && f.entity) {
        const raw = args.entity ? ENTITY_VALUE[f.entity](args.entity) : undefined;
        if (raw) v = { value: raw, display: raw, source: 'entity' };
        else if (typed !== null) v = { value: typed, display: displayValue(f.type, typed), source: 'user' };
        else v = { value: null, display: null, source: 'entity' };
      } else {
        const value = typed ?? (f.default && !(f.key in args.user) ? f.default : null);
        v = value === null ? { value: null, display: null, source: 'user' } : { value, display: displayValue(f.type, value), source: 'user' };
      }
    }
    out[f.key] = v;
  }
  checkDateOrder(out);
  return out;
}

/**
 * Связи между полями: соглашение не может быть датировано раньше договора, к которому оно относится.
 * Даты записаны как ГГГГ-ММ-ДД, поэтому сравниваются как строки.
 */
export function checkDateOrder(values: FieldValues): void {
  const contract = values.contract_date?.value;
  const addendum = values.addendum_date?.value;
  if (contract && addendum && addendum < contract) {
    throw new FieldError('addendum_date', 'Дата соглашения: не может быть раньше даты договора');
  }
}

/** Обязательные поля без значения: «Не хватает N полей». */
export function missingKeys(fields: TemplateField[], values: FieldValues): string[] {
  return fields.filter((f) => f.required && !values[f.key]?.value).map((f) => f.key);
}

/** Слово «поле» с числом: «Не заполнено: 7 полей», «Не заполнено: 1 поле», «Не заполнено: 3 поля». */
export function unfilledText(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  const word = mod100 > 10 && mod100 < 20 ? 'полей' : mod10 === 1 ? 'поле' : mod10 >= 2 && mod10 <= 4 ? 'поля' : 'полей';
  return n === 0 ? 'Все обязательные поля заполнены' : `Не заполнено: ${n} ${word}`;
}

/** Применяет правки пользователя к значениям версии: правятся только введённые вручную поля. */
export function applyEdits(
  fields: TemplateField[],
  prev: FieldValues,
  edits: Record<string, string>,
): { values: FieldValues; touched: string[] } {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const values: FieldValues = { ...prev };
  const touched: string[] = [];
  for (const [key, raw] of Object.entries(edits)) {
    const f = byKey.get(key);
    if (!f) throw new FieldError(key, 'Такого поля в документе нет');
    if (f.source === 'calc') throw new FieldError(key, `${f.label}: значение берётся из расчёта, вручную не вводится`);
    if (f.source === 'entity' && prev[key]?.source === 'entity' && prev[key]?.value) {
      throw new FieldError(key, `${f.label}: значение берётся из реквизитов юрлица`);
    }
    const value = normalizeInput(f, raw);
    const next: FieldValue =
      value === null
        ? { value: null, display: null, source: f.source === 'entity' ? 'entity' : 'user' }
        : { value, display: displayValue(f.type, value), source: 'user' };
    if ((prev[key]?.value ?? null) !== next.value) touched.push(key);
    values[key] = next;
  }
  checkDateOrder(values);
  return { values, touched };
}

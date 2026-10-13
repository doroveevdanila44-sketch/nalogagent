import type { Period } from '@/lib/calc/period';
import type { TaxKind } from '@/lib/calc/service';

/**
 * Документы: шаблон, поля, значения, статусы. Типы общие для сервера и интерфейса, без серверных
 * зависимостей. Суммы, ставки и даты расчёта попадают в документ только из CalcSnapshot
 * (результата calcTax); языковая модель суммы не пишет.
 */

export type TemplateCategory = 'contract' | 'addendum' | 'report' | 'declaration';

export const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  contract: 'Договоры',
  addendum: 'Допсоглашения',
  report: 'Отчёты',
  declaration: 'Проекты деклараций',
};

export const CATEGORIES: readonly TemplateCategory[] = ['contract', 'addendum', 'report', 'declaration'];

/** Пометка на каждом шаблоне: образцы юридически не проверены. */
export const SAMPLE_NOTE = 'Образец, проверить юристом';
export const DRAFT_WATERMARK = 'Проект';

export type FieldSource = 'entity' | 'calc' | 'user';

export const SOURCE_LABEL: Record<FieldSource, string> = {
  entity: 'Реквизиты юрлица',
  calc: 'Расчёт',
  user: 'Введено вручную',
};

export type FieldType = 'text' | 'longtext' | 'date' | 'money' | 'percent' | 'number';

/** Реквизит юрлица, который можно подставить в поле. */
export type EntityKey =
  | 'name'
  | 'form'
  | 'inn'
  | 'kpp'
  | 'ogrn'
  | 'address'
  | 'signer_name'
  | 'signer_position'
  | 'bank'
  | 'bik'
  | 'account'
  | 'corr_account'
  | 'email'
  | 'phone';

/** Что взять из результата calcTax. */
export type CalcMetric = 'total' | 'revenue' | 'rate' | 'period' | 'asof' | 'source' | 'kind';

export interface TemplateField {
  key: string;
  label: string;
  type: FieldType;
  source: FieldSource;
  required: boolean;
  /** source entity: реквизит юрлица */
  entity?: EntityKey;
  /** source calc: налог результата и что из него взять */
  calc?: { tax: TaxKind; metric: CalcMetric };
  /** Подсказка в форме дозаполнения */
  hint?: string;
  /** Значение по умолчанию для поля, вводимого вручную */
  default?: string;
  /** Для текстового пункта можно запросить предложение формулировки у провайдера */
  suggest?: boolean;
}

export interface TemplateDef {
  key: string;
  category: TemplateCategory;
  title: string;
  description: string;
  body: string;
  fields: TemplateField[];
  /** entity: по одному юрлицу, group: по группе */
  scope: 'entity' | 'group';
  /** Нужен ли выбор периода */
  needsPeriod: boolean;
  output: 'docx' | 'xlsx';
  /** Налоги, на которых стоят суммы шаблона */
  taxes: TaxKind[];
  sort: number;
}

/** Реквизиты юрлица (legal_entities.requisites). В демо вымышленные. */
export interface EntityRequisites {
  inn?: string;
  kpp?: string;
  ogrn?: string;
  address?: string;
  signerName?: string;
  signerPosition?: string;
  bank?: string;
  bik?: string;
  account?: string;
  corrAccount?: string;
  email?: string;
  phone?: string;
  /** Все реквизиты демо выдуманы */
  demo?: boolean;
}

/** Значение поля в версии документа. */
export interface FieldValue {
  /** Исходное значение: деньги и проценты строками как в расчёте, даты YYYY-MM-DD; null: нет */
  value: string | null;
  /** Как показано в документе (рубли с копейками, дата по-русски) */
  display: string | null;
  source: FieldSource;
  /** Для расчётных значений: номер снимка и шаг, из которого взято число */
  calc?: { index: number; step: string | null };
}

export type FieldValues = Record<string, FieldValue>;

export type DocStatus = 'draft' | 'review' | 'remarks' | 'approved' | 'withdrawn';

export const STATUS_LABEL: Record<DocStatus, string> = {
  draft: 'Черновик',
  review: 'На проверке',
  remarks: 'Есть замечания',
  approved: 'Согласовано',
  withdrawn: 'Отозвано',
};

export interface VersionChange {
  /** Ключ поля; created для первой версии, calc для обновления расчёта */
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

export interface DocumentSummary {
  id: string;
  templateKey: string;
  title: string;
  category: TemplateCategory;
  status: DocStatus;
  version: number;
  entityId: string | null;
  entityName: string | null;
  periodLabel: string | null;
  missing: number;
  output: 'docx' | 'xlsx';
  updatedAt: string;
}

export interface VersionInfo {
  n: number;
  authorName: string;
  createdAt: string;
  changes: VersionChange[];
  hash: string;
}

export interface CommentInfo {
  id: number;
  versionN: number;
  fieldKey: string | null;
  kind: 'comment' | 'remark' | 'approval';
  body: string;
  authorName: string;
  isDemo: boolean;
  resolved: boolean;
  createdAt: string;
}

export interface EventInfo {
  id: number;
  kind: string;
  versionN: number | null;
  actor: string;
  data: Record<string, unknown>;
  createdAt: string;
}

/** Запрос предложения формулировки у провайдера: только названия, цифр и сумм в нём нет. */
export interface SuggestRequest {
  templateKey: string;
  fieldKey: string;
  label: string;
  entityName: string | null;
  periodLabel: string | null;
}

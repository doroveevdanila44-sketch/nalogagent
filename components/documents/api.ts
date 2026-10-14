import type { Period } from '@/lib/calc/period';
import type { Activity } from '@/lib/documents/activity';
import type { TemplateCategory } from '@/lib/documents/types';

/** Шаблон в каталоге: без тела, с числом полей. */
export interface TemplateMeta {
  key: string;
  category: TemplateCategory;
  title: string;
  description: string;
  scope: 'entity' | 'group';
  needsPeriod: boolean;
  output: 'docx' | 'xlsx';
  taxes: ('vat' | 'usn' | 'profit')[];
  fields: number;
  required: number;
}

export interface EntityOption {
  id: string;
  name: string;
  form: string;
  /** Вид деятельности из справочника юрлиц: по нему шаблон предлагает юрлицо */
  activity: Activity;
}

export interface Catalog {
  sample: string;
  year: number;
  month: number;
  entities: EntityOption[];
  templates: TemplateMeta[];
}

export type PeriodKind = 'month' | 'quarter' | 'year' | 'ytd';

export const PERIOD_KIND_LABEL: Record<PeriodKind, string> = {
  month: 'Месяц',
  quarter: 'Квартал',
  year: 'Год',
  ytd: 'С начала года',
};

/** Период из выбора в форме. */
export function buildPeriod(kind: PeriodKind, year: number, month: number, quarter: number): Period {
  switch (kind) {
    case 'month':
      return { kind: 'month', year, month };
    case 'quarter':
      return { kind: 'quarter', year, quarter };
    case 'year':
      return { kind: 'year', year };
    case 'ytd':
      return { kind: 'ytd' };
  }
}

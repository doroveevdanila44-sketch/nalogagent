/**
 * Ссылки на нормы. В справочнике правил у записи есть норма текстом («НК РФ, ст. 164») и необязательный
 * адрес источника. Статьи всех правил демо принадлежат второй части НК РФ, поэтому без собственного
 * адреса правило ведёт на неё: адрес документа проверен, адреса отдельных статей у справочной
 * системы меняются, поэтому статья указывается текстом рядом.
 */
export const NK_PART_2_URL = 'https://www.consultant.ru/document/cons_doc_LAW_28165/';

export interface NormLink {
  /** «НК РФ, ст. 164» */
  text: string;
  url: string;
}

export function normLink(norm: string | null, sourceUrl: string | null): NormLink | null {
  if (!norm) return null;
  if (sourceUrl && /^https:\/\//.test(sourceUrl)) return { text: norm, url: sourceUrl };
  if (/^НК РФ/.test(norm)) return { text: norm, url: NK_PART_2_URL };
  return null;
}

/** Названия правил справочника для людей. */
export const RULE_TITLE: Record<string, string> = {
  rate_special_5: 'Ставка НДС 5%',
  rate_special_7: 'Ставка НДС 7%',
  rate_general: 'Общая ставка НДС с вычетами',
  vat_exempt_limit: 'Порог освобождения от НДС',
  limit_5: 'Лимит ставки 5%',
  limit_7: 'Лимит ставки 7%',
  usn_rate_income: 'Ставка УСН «доходы»',
  usn_rate_income_expense: 'Ставка УСН «доходы минус расходы»',
  usn_min_tax_rate: 'Минимальный налог УСН',
  profit_tax_rate: 'Ставка налога на прибыль',
};

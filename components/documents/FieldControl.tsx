'use client';

import type { TemplateField } from '@/lib/documents/types';

/**
 * Поле ввода по типу поля шаблона: текст, длинный текст, дата, сумма, число. Общее для формы
 * «Дозаполнить» и маленького окна ввода на листе документа.
 */
export function FieldControl({
  field,
  value,
  onChange,
  id,
  autoFocus,
}: {
  field: TemplateField;
  value: string;
  onChange: (value: string) => void;
  id: string;
  autoFocus?: boolean;
}) {
  const common = {
    id,
    value,
    autoFocus,
    'aria-required': field.required,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  if (field.type === 'longtext') return <textarea {...common} rows={4} maxLength={2000} />;
  if (field.type === 'date') return <input {...common} type="date" />;
  if (field.type === 'money') return <input {...common} type="text" inputMode="decimal" placeholder="5000,00" />;
  if (field.type === 'number') return <input {...common} type="text" inputMode="numeric" />;
  return <input {...common} type="text" maxLength={300} />;
}

/** Можно ли ввести значение поля вручную: расчётное нельзя, реквизит только если его нет в справочнике. */
export function isFieldEditable(
  field: TemplateField,
  value: { value: string | null; source: string } | undefined,
): boolean {
  if (field.source === 'calc') return false;
  if (field.source === 'entity') return !value?.value || value.source === 'user';
  return true;
}

import { describe, expect, it } from 'vitest';
import { moment } from '@/lib/calc';
import { aliasesFor } from './pipeline';
import { canDoLine, dataRangeText, explainUnsupported, type ExplainContext } from './unsupported';
import type { EntityRef, Unsupported } from './types';

const entities: EntityRef[] = [
  ['alfa', 'ООО «Альфа»'],
  ['beta', 'ИП Бета'],
  ['delta', 'ИП Дельта'],
  ['gamma', 'ООО «Гамма»'],
  ['epsilon', 'ООО «Эпсилон»'],
].map(([id, name]) => ({ id: id!, name: name!, aliases: aliasesFor(name!) }));

const ctx: ExplainContext = {
  entities,
  today: moment(2026, 10, 11, 12),
  data: { from: { year: 2025, month: 1 }, to: { year: 2026, month: 12 } },
  nextYear: { year: 2027, deflatorKnown: false },
};

const text = (u: Unsupported, c = ctx) => explainUnsupported(u, c).join(' ');

describe('пояснения вместо отказа', () => {
  it('диапазон данных считается из данных', () => {
    expect(dataRangeText(ctx.data!)).toBe('с января 2025 по декабрь 2026');
    expect(dataRangeText({ from: { year: 2026, month: 3 }, to: { year: 2026, month: 9 } })).toBe(
      'с марта 2026 по сентябрь 2026',
    );
  });

  it('период вне данных называет границы демо', () => {
    const t = text({ kind: 'period_out_of_data', period: { kind: 'year', year: 2024 } });
    expect(t).toBe('Данные в демо с января 2025 по декабрь 2026, за 2024 год посчитать не могу.');
  });

  const next = (reason: 'limits' | 'tax' | 'mixed' | 'other'): Unsupported => ({
    kind: 'next_year',
    year: 2027,
    period: { kind: 'year', year: 2027 },
    reason,
  });

  it('2027 год, нужны лимиты: не утверждены, жду дефлятор, прогноз НДС предлагается', () => {
    const t = text(next('limits'));
    expect(t).toContain('Лимиты 2027 пока не утверждены, жду дефлятор.');
    expect(t).toContain('Прогноз НДС на 2027 год при лимитах как в 2026 посчитать могу.');
    expect(t).not.toContain('расчёт на 2027 год не даю');
  });

  it('2027 год при известном дефляторе говорит про справочник', () => {
    const t = text(next('limits'), { ...ctx, nextYear: { year: 2027, deflatorKnown: true } });
    expect(t).toContain('Правил на 2027 год в справочнике пока нет.');
    expect(t).not.toContain('жду дефлятор');
  });

  it('2027 год: прогноз только по НДС, период двух годов, другой вопрос', () => {
    expect(text(next('tax'))).toContain('прогноз только по НДС');
    expect(text(next('mixed'))).toContain('Период захватывает 2026 и 2027 годы.');
    expect(text(next('other'))).toContain('считаю только прогноз НДС по трём ставкам');
  });

  it('налог не из списка: что агент считает', () => {
    const t = text({ kind: 'other_tax', name: 'НДФЛ' });
    expect(t).toContain('НДФЛ я не считаю.');
    expect(t).toContain('Считаю НДС, налог по УСН и налог на прибыль');
    const fees = text({ kind: 'other_tax', name: 'страховые взносы' });
    expect(fees).toContain('Страховые взносы я не считаю.');
    expect(fees).toContain('в налоге по УСН они не учтены');
  });

  it('юрлицо не из группы: список юрлиц группы', () => {
    const t = text({ kind: 'unknown_entity', name: 'ООО Ромашка' });
    expect(t).toContain('ООО Ромашка нет в группе.');
    expect(t).toContain('ООО «Альфа», ИП Бета, ИП Дельта, ООО «Гамма», ООО «Эпсилон»');
  });

  it('юридическая оценка: пояснения нет, работает набор отказов', () => {
    expect(explainUnsupported({ kind: 'legal_assessment' }, ctx)).toEqual([]);
  });

  it('строка «Что могу сейчас»: два-три примера, без чисел и длинных тире', () => {
    const line = canDoLine(ctx);
    expect(line.startsWith('Что могу сейчас:')).toBe(true);
    expect((line.match(/«/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((line.match(/«/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(line).not.toMatch(/\d/);
    expect(line).not.toMatch(/[‒-―−]/);
    expect(line).toContain('по Альфе');
  });

  it('пример месяца: последний завершённый в пределах данных', () => {
    expect(canDoLine(ctx)).toContain('НДС за сентябрь');
    // в январе первого года данных завершённого месяца в пределах данных нет: берётся первый
    const early = { ...ctx, today: moment(2025, 1, 5) };
    expect(canDoLine(early)).toContain('НДС за январь');
  });
});

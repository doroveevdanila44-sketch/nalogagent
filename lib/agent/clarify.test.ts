import { describe, expect, it } from 'vitest';
import { moment, type Period } from '@/lib/calc';
import { changeOptions, clarificationFor, narrowChoices, periodChoices, taxChoices } from './clarify';
import { interpret, type InterpretContext } from './interpret';
import { aliasesFor } from './pipeline';
import type { EntityRef } from './types';

const TODAY = moment(2026, 10, 11, 12);
const entities: EntityRef[] = [
  ['alfa', 'ООО «Альфа»'],
  ['beta', 'ИП Бета'],
  ['delta', 'ИП Дельта'],
  ['gamma', 'ООО «Гамма»'],
  ['epsilon', 'ООО «Эпсилон»'],
].map(([id, name]) => ({ id: id!, name: name!, aliases: aliasesFor(name!) }));

const ctx: InterpretContext = {
  entities,
  today: TODAY,
  previous: null,
  awaiting: [],
  refine: false,
  data: { from: { year: 2025, month: 1 }, to: { year: 2026, month: 12 } },
  nextYear: { year: 2027, deflatorKnown: false },
};

const ask = (text: string) => clarificationFor(interpret(text, ctx), entities, TODAY);
const labels = (q: { label: string }[]) => q.map((x) => x.label);

describe('уточняющий вопрос', () => {
  it('нет ни налога, ни периода: один вопрос с двумя рядами кнопок', () => {
    const c = ask('сколько платить')!;
    expect(c.text).toBe('Какой налог и за какой период посчитать?');
    expect(c.awaiting).toEqual(['tax', 'period']);
    expect(labels(c.quick)).toEqual([
      'НДС', 'УСН', 'Налог на прибыль',
      'С начала года', 'Октябрь', '3 квартал', '2026 год',
    ]);
    expect(c.quick.slice(0, 3).every((q) => q.group === 'tax')).toBe(true);
    expect(c.quick.slice(3).every((q) => q.group === 'period')).toBe(true);
  });

  it('налог назван, периода нет: спрашивается период этого налога', () => {
    const c = ask('налог на прибыль')!;
    expect(c.text).toBe('За какой период посчитать налог на прибыль?');
    expect(c.awaiting).toEqual(['period']);
    expect(c.quick.every((q) => q.group === 'period')).toBe(true);
    expect(ask('сколько НДС платить')!.text).toBe('За какой период посчитать НДС?');
    expect(ask('УСН')!.text).toBe('За какой период посчитать налог по УСН?');
  });

  it('названное юрлицо остаётся в вопросе', () => {
    expect(ask('налог по Бете')!.text).toBe('Какой налог и за какой период посчитать по ИП Бета?');
    expect(ask('УСН по Альфе и Бете')!.text).toBe('За какой период посчитать налог по УСН по ООО «Альфа» и ИП Бета?');
  });

  it('несколько налогов: выбор из названных', () => {
    const c = ask('налог на прибыль и УСН за год')!;
    expect(c.text).toBe('Какой налог посчитать: налог по УСН или налог на прибыль?');
    expect(labels(c.quick)).toEqual(['УСН', 'Налог на прибыль']);
    expect(c.awaiting).toEqual(['tax']);
  });

  it('несколько периодов: выбор одного', () => {
    const c = ask('за январь и март')!;
    expect(c.awaiting).toEqual(['period']);
    expect(labels(c.quick)).toEqual(['Январь 2026', 'Март 2026']);
  });

  it('когда всё понятно, спрашивать нечего', () => {
    expect(ask('НДС Альфа 2 квартал')).toBeNull();
    expect(ask('расчёт за февраль')).toBeNull();
    expect(ask('какая ставка выгоднее?')).toBeNull();
    expect(ask('что с порогами?')).toBeNull();
  });

  it('ближайший платёж без налога: спрашивается только налог', () => {
    const c = ask('когда платить')!;
    expect(c.text).toBe('Какой налог?');
    expect(c.awaiting).toEqual(['tax']);
  });
});

describe('кнопки', () => {
  it('периоды считаются от сегодняшней даты', () => {
    expect(labels(periodChoices(TODAY))).toEqual(['С начала года', 'Октябрь', '3 квартал', '2026 год']);
    // в январе завершённый квартал это четвёртый квартал прошлого года
    const jan = moment(2027, 1, 12);
    expect(labels(periodChoices(jan))).toEqual(['С начала года', 'Январь', '4 квартал 2026', '2027 год']);
    expect(periodChoices(jan)[2]!.text).toBe('4 квартал 2026');
  });

  it('налоги', () => {
    expect(taxChoices().map((q) => q.text)).toEqual(['НДС', 'УСН', 'налог на прибыль']);
  });

  it('«Изменить»: юрлица с «по Альфе», налоги и периоды', () => {
    const c = changeOptions(entities, TODAY);
    expect(c.entity.map((q) => q.text)).toEqual([
      'по группе', 'по Альфе', 'по Бете', 'по Дельте', 'по Гамме', 'по Эпсилону',
    ]);
    expect(c.entity[0]!.label).toBe('Вся группа');
    expect(labels(c.tax)).toEqual(['НДС', 'УСН', 'Налог на прибыль']);
    expect(c.period).toHaveLength(4);
  });

  it('сужение до юрлица без пункта «группа»', () => {
    expect(narrowChoices(entities).map((q) => q.label)).toEqual(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон']);
  });

  it('текст кнопки понимается тем же разбором, что и сообщение пользователя', () => {
    const c = changeOptions(entities, TODAY);
    for (const q of c.period) {
      const i = interpret(q.text, ctx);
      expect(i.period, q.text).not.toBeNull();
    }
    for (const q of c.entity.slice(1)) {
      expect(interpret(q.text, ctx).entities, q.text).toHaveLength(1);
    }
    for (const q of c.tax) expect(interpret(q.text, ctx).tax, q.text).not.toBeNull();
    const periods: Period[] = c.period.map((q) => interpret(q.text, ctx).period!);
    expect(periods[0]).toEqual({ kind: 'ytd' });
  });

  it('в подписях нет длинных тире', () => {
    const all = [
      ...changeOptions(entities, TODAY).entity,
      ...taxChoices(),
      ...periodChoices(TODAY),
      ...(ask('сколько платить')?.quick ?? []),
    ];
    const text = all.map((q) => `${q.label} ${q.text}`).join(' ') + (ask('сколько платить')?.text ?? '');
    expect(text).not.toMatch(/[‒-―−]/);
  });
});

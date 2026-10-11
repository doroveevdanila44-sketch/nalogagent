import { describe, expect, it } from 'vitest';
import { moment, type Period } from '@/lib/calc';
import { answerKind, buildInterpretation, extractFields, interpret, sanitizeFields, type InterpretContext } from './interpret';
import { aliasesFor } from './pipeline';
import type { EntityRef, Interpretation, Scenario, Slot, TaxKind, Unsupported } from './types';

/** Сегодня 11 октября 2026: октябрь идёт, данные демо с января 2025 по декабрь 2026 */
const TODAY = moment(2026, 10, 11, 12);

const entities: EntityRef[] = [
  ['alfa', 'ООО «Альфа»'],
  ['beta', 'ИП Бета'],
  ['delta', 'ИП Дельта'],
  ['gamma', 'ООО «Гамма»'],
  ['epsilon', 'ООО «Эпсилон»'],
].map(([id, name]) => ({ id: id!, name: name!, aliases: aliasesFor(name!) }));

const base: InterpretContext = {
  entities,
  today: TODAY,
  previous: null,
  awaiting: [],
  refine: false,
  data: { from: { year: 2025, month: 1 }, to: { year: 2026, month: 12 } },
  nextYear: { year: 2027, deflatorKnown: false },
};

const ctx = (o: Partial<InterpretContext> = {}): InterpretContext => ({ ...base, ...o });

const month = (year: number, m: number): Period => ({ kind: 'month', year, month: m });
const quarter = (year: number, q: number): Period => ({ kind: 'quarter', year, quarter: q });
const range = (from: string, to: string): Period => ({ kind: 'range', from, to });

interface Want {
  entities?: string[];
  mode?: Interpretation['entityMode'];
  tax?: TaxKind | null;
  period?: Period | null;
  scenario?: Scenario | null;
  rate?: number | null;
  /** Слоты, которых не хватает или которые неоднозначны (без допущений) */
  blocking?: Slot[];
  /** Слоты, взятые по умолчанию */
  assumed?: Slot[];
  unsupported?: Unsupported['kind'] | null;
}

const slots = (i: Interpretation, kinds: ('missing' | 'multiple' | 'assumed')[]) =>
  [...new Set(i.ambiguities.filter((a) => kinds.includes(a.kind)).map((a) => a.slot))].sort();

function check(text: string, w: Want, c: InterpretContext = base) {
  const i = interpret(text, c);
  if (w.entities !== undefined) expect(i.entities, `${text}: юрлица`).toEqual(w.entities);
  if (w.mode !== undefined) expect(i.entityMode, `${text}: охват`).toBe(w.mode);
  if (w.tax !== undefined) expect(i.tax, `${text}: налог`).toBe(w.tax);
  if (w.period !== undefined) expect(i.period, `${text}: период`).toEqual(w.period);
  if (w.scenario !== undefined) expect(i.scenario, `${text}: сценарий`).toBe(w.scenario);
  if (w.rate !== undefined) expect(i.rate, `${text}: ставка`).toBe(w.rate);
  if (w.blocking !== undefined) expect(slots(i, ['missing', 'multiple']), `${text}: не хватает`).toEqual([...w.blocking].sort());
  if (w.assumed !== undefined) expect(slots(i, ['assumed']), `${text}: допущено`).toEqual([...w.assumed].sort());
  if (w.unsupported !== undefined) expect(i.unsupported?.kind ?? null, `${text}: не поддерживается`).toBe(w.unsupported);
  return i;
}

describe('понимание вопроса: таблица формулировок', () => {
  const table: [string, Want][] = [
    // период: месяцы, падежи, прилагательные
    ['расчёт за февраль', { mode: 'none', tax: 'vat', period: month(2026, 2), blocking: [], assumed: ['entity', 'tax'] }],
    ['НДС за февраль', { tax: 'vat', period: month(2026, 2), assumed: ['entity'] }],
    ['налог в феврале', { period: month(2026, 2) }],
    ['февральский НДС', { period: month(2026, 2) }],
    ['НДС за февраль 2025', { period: month(2025, 2), unsupported: null }],
    ['что платили в мае', { period: month(2026, 5) }],
    ['НДС за сентября', { period: month(2026, 9) }],
    // кварталы
    ['НДС Альфа 2 квартал', { entities: ['alfa'], mode: 'named', tax: 'vat', period: quarter(2026, 2), blocking: [], assumed: [] }],
    ['налог за 1 квартал', { period: quarter(2026, 1) }],
    ['за 3 квартал 2026', { period: quarter(2026, 3) }],
    ['НДС за первый квартал 2025', { period: quarter(2025, 1) }],
    ['НДС во втором квартале', { period: quarter(2026, 2) }],
    ['УСН за IV квартал', { tax: 'usn', period: quarter(2026, 4) }],
    ['Сколько платить за квартал?', { period: quarter(2026, 4), tax: 'vat', assumed: ['entity', 'period', 'tax'] }],
    // год, с начала года, относительные
    ['за 2025 год', { period: { kind: 'year', year: 2025 } }],
    ['налог за год 2025', { period: { kind: 'year', year: 2025 } }],
    ['НДС в 2026 году', { tax: 'vat', period: { kind: 'year', year: 2026 } }],
    ['с начала года', { period: { kind: 'ytd' } }],
    ['сколько НДС за год', { tax: 'vat', period: { kind: 'year', year: 2026 } }],
    ['за прошлый месяц', { period: month(2026, 9) }],
    ['за этот месяц', { period: month(2026, 10) }],
    ['в прошлом квартале', { period: quarter(2026, 3) }],
    ['за прошлый год', { period: { kind: 'year', year: 2025 } }],
    // диапазоны
    ['за октябрь-декабрь', { period: range('2026-10-01', '2026-12-31') }],
    ['с марта по май', { period: range('2026-03-01', '2026-05-31') }],
    ['январь-март 2026', { period: range('2026-01-01', '2026-03-31') }],
    ['за февраль и март', { period: range('2026-02-01', '2026-03-31') }],
    ['с 1 по 15 октября', { period: range('2026-10-01', '2026-10-15') }],
    ['за полугодие', { period: range('2026-01-01', '2026-06-30') }],
    ['за 9 месяцев', { period: range('2026-01-01', '2026-09-30') }],
    // два несмежных месяца: сначала спрашивается период, налог потом берётся по умолчанию
    ['за январь и март', { period: null, blocking: ['period', 'tax'] }],
    // юрлица
    ['по Бете за август', { entities: ['beta'], mode: 'named', period: month(2026, 8) }],
    ['у Эпсилон за март', { entities: ['epsilon'], period: month(2026, 3) }],
    ['налог по Гамме за июнь 2025 года', { entities: ['gamma'], period: month(2025, 6) }],
    ['НДС по Альфе и Бете за август', { entities: ['alfa', 'beta'], mode: 'named' }],
    ['НДС по всем юрлицам за август', { mode: 'group', entities: [] }],
    ['по группе УСН за 1 квартал', { mode: 'group', tax: 'usn', period: quarter(2026, 1), assumed: [] }],
    // налоги
    ['УСН Эпсилон за март', { tax: 'usn', entities: ['epsilon'], period: month(2026, 3), blocking: [], assumed: [] }],
    ['налог на упрощёнке за квартал', { tax: 'usn' }],
    ['налог на прибыль за год?', { tax: 'profit', period: { kind: 'year', year: 2026 } }],
    ['налог на добавленную стоимость за март', { tax: 'vat', period: month(2026, 3) }],
    ['налог на прибыль и УСН за год', { tax: null, blocking: ['tax'] }],
    // что не хватает
    ['сколько платить', { tax: null, period: null, blocking: ['period', 'tax'] }],
    ['сколько НДС платить', { tax: 'vat', period: null, blocking: ['period'] }],
    ['налог на прибыль', { tax: 'profit', blocking: ['period'] }],
    ['налог по Бете', { entities: ['beta'], blocking: ['period', 'tax'] }],
    // сценарии
    ['какая ставка выгоднее?', { scenario: 'compare_rates', blocking: [] }],
    ['сравни ставки по Альфе', { scenario: 'compare_rates', entities: ['alfa'] }],
    ['какая ставка у Гаммы', { scenario: 'rate', entities: ['gamma'], blocking: [] }],
    ['что с порогами?', { scenario: 'threshold', blocking: [] }],
    ['прогноз НДС на квартал', { scenario: 'forecast', tax: 'vat', period: quarter(2026, 4) }],
    ['когда ближайший платёж по НДС', { scenario: 'payment', tax: 'vat', blocking: [] }],
    ['Сколько НДС за февраль по ставке 22%', { scenario: null, rate: 22, period: month(2026, 2) }],
    ['объясни вычет', { scenario: 'deduct' }],
    ['как влияют закупки на налог', { scenario: 'deduct' }],
    ['есть ли признаки дробления', { scenario: 'fragmentation' }],
    ['что если Альфа купит 2 машины по 6 млн', { scenario: 'cars', entities: ['alfa'] }],
    // неподдерживаемое
    ['налог за 2027', { unsupported: 'next_year' }],
    ['НДС за январь 2027', { unsupported: 'next_year' }],
    ['налог за 2024 год', { unsupported: 'period_out_of_data' }],
    ['НДС за 2028 год', { unsupported: 'period_out_of_data' }],
    ['НДФЛ за март', { unsupported: 'other_tax' }],
    ['страховые взносы за год', { unsupported: 'other_tax' }],
    ['ЕНВД по Бете', { unsupported: 'other_tax' }],
    ['налог по ООО Ромашка за февраль', { unsupported: 'unknown_entity' }],
    ['посчитай по Омеге', { unsupported: 'unknown_entity' }],
    ['законно ли применять ставку 5%', { unsupported: 'legal_assessment' }],
    ['оцени схему с точки зрения закона', { unsupported: 'legal_assessment' }],
  ];

  it('не меньше 30 формулировок', () => {
    expect(table.length).toBeGreaterThanOrEqual(30);
  });

  for (const [text, want] of table) {
    it(`«${text}»`, () => {
      check(text, want);
    });
  }
});

describe('ставка и ответ по понятому вопросу', () => {
  it('УСН 6% ставкой НДС не считается', () => {
    expect(interpret('налог по УСН 6% за март', base).rate).toBeNull();
    expect(interpret('НДС 7% за март', base).rate).toBe(7);
  });

  it('какой раздел отвечает', () => {
    const kind = (t: string) => answerKind(interpret(t, base));
    expect(kind('расчёт за февраль')).toBe('amount');
    expect(kind('какая ставка выгоднее?')).toBe('rates');
    expect(kind('что с порогами?')).toBe('warnings');
    expect(kind('когда платить НДС')).toBe('payment');
    expect(kind('что если купим 3 машины')).toBe('cars');
    expect(kind('объясни вычет')).toBe('deduct');
  });
});

describe('короткий ответ продолжает прежний вопрос', () => {
  const asked = interpret('сколько НДС платить', base);

  it('«февраль» после вопроса про НДС: налог остаётся, период добавляется', () => {
    const i = interpret('февраль', ctx({ previous: asked, awaiting: ['period'] }));
    expect(i.tax).toBe('vat');
    expect(i.period).toEqual(month(2026, 2));
    expect(slots(i, ['missing', 'multiple'])).toEqual([]);
    // налог назван в прежнем вопросе: допущения нет
    expect(slots(i, ['assumed'])).toEqual(['entity']);
  });

  it('«1 квартал» и «с начала года» тоже', () => {
    expect(interpret('1 квартал', ctx({ previous: asked, awaiting: ['period'] })).period).toEqual(quarter(2026, 1));
    expect(interpret('с начала года', ctx({ previous: asked, awaiting: ['period'] })).period).toEqual({ kind: 'ytd' });
  });

  it('налог в ответ на вопрос «какой налог и за какой период», затем период', () => {
    const first = interpret('сколько платить', base);
    const second = interpret('налог на прибыль', ctx({ previous: first, awaiting: ['tax', 'period'] }));
    expect(second.tax).toBe('profit');
    expect(slots(second, ['missing'])).toEqual(['period']);
    const third = interpret('с начала года', ctx({ previous: second, awaiting: ['period'] }));
    expect(third.tax).toBe('profit');
    expect(third.period).toEqual({ kind: 'ytd' });
    expect(slots(third, ['missing', 'multiple'])).toEqual([]);
  });

  it('юрлицо из прежнего вопроса сохраняется', () => {
    const first = interpret('налог по Бете', base);
    const second = interpret('НДС за февраль', ctx({ previous: first, awaiting: ['tax', 'period'] }));
    expect(second.entities).toEqual(['beta']);
    expect(second.tax).toBe('vat');
    expect(second.period).toEqual(month(2026, 2));
  });

  it('«а по Бете?» после расчёта меняет только юрлицо', () => {
    const prev = interpret('НДС за февраль', base);
    const i = interpret('а по Бете?', ctx({ previous: prev }));
    expect(i.entities).toEqual(['beta']);
    expect(i.tax).toBe('vat');
    expect(i.period).toEqual(month(2026, 2));
  });

  it('«а за март?» меняет только период', () => {
    const prev = interpret('УСН по Бете за февраль', base);
    const i = interpret('а за март?', ctx({ previous: prev }));
    expect(i.entities).toEqual(['beta']);
    expect(i.tax).toBe('usn');
    expect(i.period).toEqual(month(2026, 3));
  });

  it('кнопка «Изменить» продолжает вопрос безусловно', () => {
    const prev = interpret('расчёт за февраль', base);
    const i = interpret('УСН', ctx({ previous: prev, refine: true }));
    expect(i.tax).toBe('usn');
    expect(i.period).toEqual(month(2026, 2));
  });

  it('налог в сравнении ставок: новый период переводит вопрос в расчёт суммы', () => {
    const prev = interpret('какая ставка выгоднее?', base);
    const keep = interpret('по Бете', ctx({ previous: prev }));
    expect(keep.scenario).toBe('compare_rates');
    expect(keep.entities).toEqual(['beta']);
    const next = interpret('а за март', ctx({ previous: prev }));
    expect(next.scenario).toBeNull();
    expect(next.period).toEqual(month(2026, 3));
  });

  it('новый целый вопрос не наследует юрлицо', () => {
    const prev = interpret('что по Альфе за март', base);
    const i = interpret('налог на прибыль за год?', ctx({ previous: prev }));
    expect(i.entityMode).toBe('none');
    expect(i.entities).toEqual([]);
  });

  it('вопрос со своим сценарием не склеивается с ожиданием', () => {
    const i = interpret('что с порогами?', ctx({ previous: asked, awaiting: ['period'] }));
    expect(i.scenario).toBe('threshold');
    expect(i.tax).toBeNull();
    expect(i.period).toBeNull();
  });

  it('непонятый период из прежнего вопроса заменяется новым', () => {
    const out = interpret('налог за 2027', base);
    expect(out.unsupported?.kind).toBe('next_year');
    const fixed = interpret('а за 2026 год', ctx({ previous: out }));
    expect(fixed.period).toEqual({ kind: 'year', year: 2026 });
    expect(fixed.unsupported).toBeNull();
  });
});

describe('поля от модели проходят проверку', () => {
  it('лишнее отбрасывается, допустимое остаётся', () => {
    const raw = sanitizeFields(
      {
        entities: ['alfa', 'nope', 'alfa'],
        taxes: ['vat', 'excise' as TaxKind],
        periods: [
          { period: month(2026, 13) },
          { period: month(2026, 2), note: 'проверка' },
          { period: { kind: 'year', year: 1800 } },
        ],
        scenario: 'drop-tables' as Scenario,
        rate: 6 as 5,
        unknownEntities: ['', 'Ромашка'],
      },
      base,
    );
    expect(raw.entities).toEqual(['alfa']);
    expect(raw.taxes).toEqual(['vat']);
    expect(raw.periods).toEqual([{ period: month(2026, 2), note: 'проверка' }]);
    expect(raw.scenario).toBeNull();
    expect(raw.rate).toBeNull();
    expect(raw.unknownEntities).toEqual(['Ромашка']);
  });

  it('модель только извлекает поля: решение о вопросе принимает код', () => {
    // «модель» нашла юрлицо и налог, периода нет: код спрашивает период
    const i = buildInterpretation(
      sanitizeFields({ entities: ['gamma'], taxes: ['usn'], fragment: false }, base),
      base,
    );
    expect(i.entities).toEqual(['gamma']);
    expect(i.tax).toBe('usn');
    expect(slots(i, ['missing'])).toEqual(['period']);
  });

  it('поля правил заглушки это те же поля, что вернёт модель', () => {
    const f = extractFields('НДС по Бете за август', base);
    expect(f.entities).toEqual(['beta']);
    expect(f.taxes).toEqual(['vat']);
    expect(f.periods).toEqual([{ period: month(2026, 8), note: undefined }]);
    expect(f.fragment).toBe(true);
  });
});

describe('уверенность', () => {
  it('растёт с названными юрлицом, налогом и периодом', () => {
    const none = interpret('сколько платить', base).confidence;
    const some = interpret('НДС за февраль', base).confidence;
    const full = interpret('НДС Альфа 2 квартал', base).confidence;
    expect(none).toBeLessThan(some);
    expect(some).toBeLessThan(full);
    expect(full).toBeLessThanOrEqual(1);
  });

  it('у неподдерживаемого не выше 0,3', () => {
    expect(interpret('налог за 2027', base).confidence).toBeLessThanOrEqual(0.3);
  });
});

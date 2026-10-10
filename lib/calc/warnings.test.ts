import { describe, expect, it } from 'vitest';
import { dec } from './decimal';
import { SEED_ENTITIES, seedCtx } from './demo-data';
import { buildWarnings, warningCounter } from './warnings';
import { moment } from './time';
import type { EntityInput } from './types';

const T = moment(2026, 10, 10, 12, 0, 0);
const ctx = seedCtx(T);
const nb = (s: string) => s.replace(/ /g, ' ');

describe('предупреждения на дату теста', () => {
  const list = buildWarnings(SEED_ENTITIES, {}, ctx, T);

  it('порядок: срочные, внимание, к сведению', () => {
    const levels = list.map((w) => w.level);
    const sorted = [...levels].sort((a, b) => ({ crit: 0, warn: 1, info: 2 })[a] - ({ crit: 0, warn: 1, info: 2 })[b]);
    expect(levels).toEqual(sorted);
  });

  it('Дельта пересечёт порог 20 млн в декабре, срочно', () => {
    const w = list.find((x) => x.kind === 'threshold-crossing')!;
    expect(w.level).toBe('crit');
    expect(w.tag).toBe('Срочно');
    expect(nb(w.title)).toBe('ИП Дельта пересечёт порог 20 млн около 19 декабря');
    expect(nb(w.text)).toContain('1 января 2027');
    expect(nb(w.text)).toContain('995 238 ₽ при 5%');
    expect(nb(w.text)).toContain('3 090 459 ₽ при 22%');
  });

  it('Гамма далеко от порога: предупреждения о запасе нет', () => {
    expect(list.some((w) => w.kind === 'near-threshold')).toBe(false);
  });

  it('Альфа: 22% выгоднее выбранных 5%', () => {
    const w = list.find((x) => x.kind === 'better-rate' && x.entityId === 'alfa')!;
    expect(nb(w.title)).toBe('ООО «Альфа»: ставка 22% выгоднее на 430 545 ₽ в год');
    expect(w.text).toContain('покупатели-юрлица');
  });

  it('признаки единого бизнеса с долей от лимита 272,5 млн', () => {
    const w = list.find((x) => x.kind === 'unified-business')!;
    expect(w.level).toBe('warn');
    expect(nb(w.text)).toContain('77,7 млн');
    expect(nb(w.text)).toContain('29% от лимита ставки 5% (272,5 млн)');
  });

  it('окно выбора ставки и дефлятор: к сведению', () => {
    expect(nb(list.find((x) => x.kind === 'rate-window')!.title)).toBe('Окно выбора ставки на 2027 год: ноябрь и декабрь');
    expect(list.find((x) => x.kind === 'deflator-unknown')!.title).toBe('Дефлятор на 2027 год не утверждён');
  });

  it('счётчик', () => {
    expect(warningCounter(list)).toBe('Срочных: 1, всего: 7');
  });

  it('после выбора лучшей ставки предупреждение о ставке пропадает', () => {
    const l2 = buildWarnings(SEED_ENTITIES, { alfa: 22 }, ctx, T);
    expect(l2.some((x) => x.kind === 'better-rate' && x.entityId === 'alfa')).toBe(false);
  });

  it('запас до порога меньше 5 млн: предупреждение для освобождённого без пересечения', () => {
    const near: EntityInput = { ...SEED_ENTITIES[3]!, id: 'near', name: 'ИП Близкий', annualRevenue: dec(16_500_000) };
    const l = buildWarnings([near], {}, ctx, T);
    const w = l.find((x) => x.kind === 'near-threshold')!;
    expect(w.level).toBe('warn');
    expect(nb(w.title)).toBe('ИП Близкий: запас до порога 3,5 млн');
  });

  it('окно выбора ставки не показывается весной', () => {
    const spring = moment(2026, 4, 10);
    const l = buildWarnings(SEED_ENTITIES, {}, seedCtx(spring), spring);
    expect(l.some((x) => x.kind === 'rate-window')).toBe(false);
  });
});

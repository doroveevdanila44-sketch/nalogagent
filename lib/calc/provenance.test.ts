import { describe, expect, it } from 'vitest';
import { dec } from './decimal';
import {
  StepLog,
  evalExpression,
  formatLoadedAt,
  moneyText,
  numText,
  sourceLine,
  sourceRef,
  verifySteps,
} from './provenance';
import { epochFromWallClock, momentFromEpoch } from './time';

/** Неразрывные пробелы формата ru-RU сводим к обычным, чтобы сравнивать с читаемой строкой. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

const none = () => {
  throw new Error('ссылок нет');
};

describe('вычисление выражений шага', () => {
  it('арифметика с приоритетами и скобками', () => {
    expect(evalExpression('1 + 2 * 3', none).toNumber()).toBe(7);
    expect(evalExpression('(1 + 2) * 3', none).toNumber()).toBe(9);
    expect(evalExpression('10 / 4 - 1', none).toNumber()).toBe(1.5);
    expect(evalExpression('-5 + 2', none).toNumber()).toBe(-3);
    expect(evalExpression('2 * -3', none).toNumber()).toBe(-6);
  });

  it('формула НДС 5% точно, без float', () => {
    // 1 988 000 × 5 / 105 = 94 666,666...
    const v = evalExpression('1988000 * 5 / 105', none);
    expect(v.toDecimalPlaces(2).toString()).toBe('94666.67');
    expect(v.minus(dec(1988000).times(5).div(105)).isZero()).toBe(true);
  });

  it('функции max, min, round2', () => {
    expect(evalExpression('max(1, 5, 3)', none).toNumber()).toBe(5);
    expect(evalExpression('min(4, 2)', none).toNumber()).toBe(2);
    expect(evalExpression('round2(94666.666666)', none).toString()).toBe('94666.67');
    expect(evalExpression('round2(0.005)', none).toString()).toBe('0.01');
    expect(evalExpression('max(0, 3 - 10)', none).toNumber()).toBe(0);
  });

  it('ссылки на шаги', () => {
    const v = evalExpression('s1 * 5 / 105', (id) => {
      if (id === 's1') return dec(2100);
      throw new Error('нет');
    });
    expect(v.toNumber()).toBe(100);
  });

  it('ошибки: чужие символы, деление на ноль, лишнее, неизвестная функция', () => {
    expect(() => evalExpression('1 + $', none)).toThrow();
    expect(() => evalExpression('1 / 0', none)).toThrow(/ноль/);
    expect(() => evalExpression('1 2', none)).toThrow();
    expect(() => evalExpression('foo(1)', none)).toThrow(/функци/);
    expect(() => evalExpression('s9', none)).toThrow();
    expect(() => evalExpression('(1 + 2', none)).toThrow();
  });
});

describe('проверка шагов', () => {
  it('верные шаги проходят', () => {
    const log = new StepLog();
    const a = log.add({ label: 'a', text: '', expression: '1988000', result: dec(1988000), entityId: null, month: null });
    log.add({
      label: 'b',
      text: '',
      expression: `${a.id} * 5 / 105`,
      result: dec(1988000).times(5).div(105),
      entityId: null,
      month: null,
    });
    expect(verifySteps(log.steps)).toEqual([]);
  });

  it('неверный результат, ссылка вперёд и повтор номера находятся', () => {
    const log = new StepLog();
    log.add({ label: 'a', text: '', expression: '10', result: dec(11), entityId: null, month: null });
    expect(verifySteps(log.steps)[0]).toMatch(/s1/);

    const forward = [
      { id: 's1', label: '', text: '', expression: 's2 + 1', result: dec(2), entityId: null, month: null },
      { id: 's2', label: '', text: '', expression: '1', result: dec(1), entityId: null, month: null },
    ];
    expect(verifySteps(forward).join(' ')).toMatch(/более поздний/);

    const dup = [
      { id: 's1', label: '', text: '', expression: '1', result: dec(1), entityId: null, month: null },
      { id: 's1', label: '', text: '', expression: '2', result: dec(2), entityId: null, month: null },
    ];
    expect(verifySteps(dup).join(' ')).toMatch(/повторяется/);
  });
});

describe('текст и время', () => {
  it('сумма: рубли без копеек, если их нет', () => {
    expect(plain(moneyText(dec(1988000)))).toBe('1 988 000 ₽');
    expect(plain(moneyText(dec('94666.666666')))).toBe('94 666,67 ₽');
  });

  it('число с запятой без лишних нулей', () => {
    expect(numText(dec('0.8200'))).toBe('0,82');
    expect(numText(5)).toBe('5');
    expect(numText(dec(10.5))).toBe('10,5');
  });

  it('стенные часы в поясе приложения: 10 октября 2026, 18:00', () => {
    const kam = epochFromWallClock('Asia/Kamchatka', 2026, 10, 10, 18, 0);
    expect(new Date(kam).toISOString()).toBe('2026-10-10T06:00:00.000Z');
    const msk = epochFromWallClock('Europe/Moscow', 2026, 10, 10, 18, 0);
    expect(new Date(msk).toISOString()).toBe('2026-10-10T15:00:00.000Z');
    for (const tz of ['Asia/Kamchatka', 'Europe/Moscow', 'UTC', 'America/New_York']) {
      const t = epochFromWallClock(tz, 2026, 10, 10, 18, 0);
      const m = momentFromEpoch(t, tz);
      expect([m.year, m.month, m.day, m.secondsOfDay]).toEqual([2026, 9, 10, 18 * 3600]);
    }
  });

  it('дата загрузки по-русски', () => {
    const iso = new Date(epochFromWallClock('Asia/Kamchatka', 2026, 10, 10, 18, 0)).toISOString();
    expect(formatLoadedAt(iso, 'Asia/Kamchatka')).toBe('10 октября 2026, 18:00');
    const src = sourceRef({ id: 'demo-1c', kind: 'demo_1c', title: 'Выгрузка из 1С (демо)', isDemo: true, loadedAt: new Date(iso) });
    expect(src.loadedAt).toBe(iso);
    expect(plain(sourceLine(src, 'Asia/Kamchatka'))).toBe('Выгрузка из 1С, загружена 10 октября 2026, 18:00');
  });
});

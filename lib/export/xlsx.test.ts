import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCalcData } from '@/lib/db/queries';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import type { Db } from '@/lib/db/client';
import { calcTax, type CalcData, type CalcResult, type CalcTaxArgs } from '@/lib/calc/service';
import { moment } from '@/lib/calc/time';
import { exportFileName } from '@/lib/provenance/query';
import { toSnapshot } from '@/lib/provenance/snapshot';
import { leavesOf, parseExpression, printExcel, signatureOf } from './excel-formula';
import { SHEET_CALC, SHEET_MONTHS, SHEET_SOURCE, SHEET_TOTAL, buildWorkbook } from './xlsx';

/** 2026-10-10 12:00:00, как в CALC.md. */
const T = moment(2026, 10, 10, 12, 0, 0);
const AT = Date.UTC(2026, 9, 10, 0, 0, 0);
const TZ = 'Asia/Kamchatka';

let db: Db;
let close: () => Promise<void>;
let data: CalcData;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db, { tz: TZ });
  data = await loadCalcData(db, T);
});
afterAll(async () => close());

const run = (args: Omit<CalcTaxArgs, 'entityIds'> & { entityIds?: CalcTaxArgs['entityIds'] }): CalcResult =>
  calcTax({ entityIds: 'all', ...args }, data);

async function load(results: CalcResult[]): Promise<ExcelJS.Workbook> {
  const buf = await buildWorkbook(results, { at: AT, tz: TZ });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

// ===== Небольшой вычислитель формул Excel: только то, что пишет выгрузка =====

type CellVal = ExcelJS.CellValue;

function cellNumber(v: CellVal): number | null {
  if (typeof v === 'number') return v;
  return null;
}

/** Пересчитывает формулу ячейки по значениям других ячеек, не доверяя сохранённому результату. */
function evaluate(wb: ExcelJS.Workbook, sheet: string, address: string, memo = new Map<string, number>()): number {
  const key = `${sheet}!${address}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const cell = wb.getWorksheet(sheet)!.getCell(address);
  const v = cell.value as CellVal;
  let out: number;
  if (v && typeof v === 'object' && 'formula' in v && typeof v.formula === 'string') {
    out = evalFormula(wb, sheet, v.formula, memo);
  } else {
    const n = cellNumber(v);
    if (n === null) throw new Error(`Ячейка ${key} не число: ${JSON.stringify(v)}`);
    out = n;
  }
  memo.set(key, out);
  return out;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colLetters(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function evalFormula(wb: ExcelJS.Workbook, sheet: string, formula: string, memo: Map<string, number>): number {
  const re = /\s*('(?:[^']+)'!)?([A-Z]+[0-9]+)(?::([A-Z]+[0-9]+))?|\s*([0-9]*\.?[0-9]+)|\s*([A-Z]+)(?=\()|\s*([-+*/(),])/y;
  type T = { k: 'cell'; sheet: string; a: string; b?: string } | { k: 'num'; v: number } | { k: 'fn'; v: string } | { k: 'op'; v: string };
  const toks: T[] = [];
  re.lastIndex = 0;
  while (re.lastIndex < formula.length) {
    const m = re.exec(formula);
    if (!m) throw new Error(`Не разобрать формулу: ${formula}`);
    if (m[2]) toks.push({ k: 'cell', sheet: m[1] ? m[1].slice(1, -2) : sheet, a: m[2], b: m[3] });
    else if (m[4] !== undefined) toks.push({ k: 'num', v: Number(m[4]) });
    else if (m[5]) toks.push({ k: 'fn', v: m[5] });
    else toks.push({ k: 'op', v: m[6]! });
  }
  let p = 0;
  const op = (v: string) => toks[p]?.k === 'op' && (toks[p] as { v: string }).v === v;
  const cellsOf = (t: Extract<T, { k: 'cell' }>): number[] => {
    if (!t.b) return [evaluate(wb, t.sheet, t.a, memo)];
    const [, c1, r1] = /^([A-Z]+)([0-9]+)$/.exec(t.a)!;
    const [, c2, r2] = /^([A-Z]+)([0-9]+)$/.exec(t.b)!;
    const out: number[] = [];
    for (let r = Number(r1); r <= Number(r2); r++) {
      for (let c = colIndex(c1!); c <= colIndex(c2!); c++) out.push(evaluate(wb, t.sheet, `${colLetters(c)}${r}`, memo));
    }
    return out;
  };
  const expr = (): number => {
    let v = term();
    while (op('+') || op('-')) {
      const o = (toks[p++] as { v: string }).v;
      const r = term();
      v = o === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (op('*') || op('/')) {
      const o = (toks[p++] as { v: string }).v;
      const r = unary();
      v = o === '*' ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    if (op('-')) {
      p++;
      return -unary();
    }
    return primary();
  };
  const primary = (): number => {
    const t = toks[p++]!;
    if (t.k === 'num') return t.v;
    if (t.k === 'cell') return cellsOf(t)[0]!;
    if (t.k === 'op' && t.v === '(') {
      const v = expr();
      p++;
      return v;
    }
    if (t.k === 'fn') {
      p++; // (
      const args: number[] = [];
      for (;;) {
        // диапазон разворачивается в список значений
        if (toks[p]?.k === 'cell' && (toks[p] as { b?: string }).b) args.push(...cellsOf(toks[p++] as Extract<T, { k: 'cell' }>));
        else args.push(expr());
        if (op(',')) {
          p++;
          continue;
        }
        p++; // )
        break;
      }
      switch (t.v) {
        case 'SUM':
          return args.reduce((a, b) => a + b, 0);
        case 'MAX':
          return Math.max(...args);
        case 'MIN':
          return Math.min(...args);
        case 'ROUND': {
          const f = 10 ** args[1]!;
          return Math.round((args[0]! + Number.EPSILON) * f) / f;
        }
      }
    }
    throw new Error(`Неожиданный токен в формуле ${formula}`);
  };
  return expr();
}

function formulaCells(wb: ExcelJS.Workbook, sheet: string): { address: string; formula: string; result: number }[] {
  const out: { address: string; formula: string; result: number }[] = [];
  wb.getWorksheet(sheet)!.eachRow((row) => {
    row.eachCell((cell) => {
      const v = cell.value as CellVal;
      if (v && typeof v === 'object' && 'formula' in v && typeof v.formula === 'string') {
        // exceljs при чтении теряет кэш нулевого результата (в самом файле он записан как <v>0</v>)
        out.push({ address: cell.address, formula: v.formula, result: v.result === undefined ? 0 : Number(v.result) });
      }
    });
  });
  return out;
}

// ===== Формулы =====

describe('перевод выражений шагов в формулы Excel', () => {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => `${String.fromCharCode(68 + i)}7`);

  it('НДС 5%: ссылка на выручку, ставка, ставка плюс 100', () => {
    const ast = parseExpression('s1 * 5 / 105');
    expect(signatureOf(ast)).toBe('S*N/N');
    expect(printExcel(ast, cells(3))).toBe('D7*E7/F7');
  });

  it('НДС 22% с вычетом: скобки сохраняются', () => {
    const ast = parseExpression('s4 * 22 / 122 * (1 - 0.55)');
    expect(signatureOf(ast)).toBe('S*N/N*(N-N)');
    expect(printExcel(ast, cells(5))).toBe('D7*E7/F7*(G7-H7)');
  });

  it('round2 и сумма диапазоном', () => {
    const ast = parseExpression('round2(s1 + s2 + s3)');
    expect(printExcel(ast, cells(3), { contiguous: true })).toBe('ROUND(SUM(D7:F7),2)');
    expect(printExcel(ast, cells(3))).toBe('ROUND(D7+E7+F7,2)');
  });

  it('max, min и вычитание справа в скобках', () => {
    expect(printExcel(parseExpression('max(0, s1 - 100)'), cells(3))).toBe('MAX(D7,E7-F7)');
    expect(printExcel(parseExpression('s1 - (s2 - s3)'), cells(3))).toBe('D7-(E7-F7)');
    expect(printExcel(parseExpression('s1 / (s2 * s3)'), cells(3))).toBe('D7/(E7*F7)');
    expect(leavesOf(parseExpression('max(s1, s2) * 2')).map((l) => l.t)).toEqual(['ref', 'ref', 'num']);
  });
});

// ===== Книга =====

describe('файл Excel: листы и живые формулы', () => {
  const cases: [string, () => CalcResult[]][] = [
    ['НДС с начала года по группе', () => [run({ tax: 'vat', period: { kind: 'ytd' } })]],
    ['НДС за год, по трём ставкам', () => [5, 7, 22].map((rate) => run({ tax: 'vat', rate: rate as 5 | 7 | 22, period: { kind: 'year', year: 2026 } }))],
    ['НДС за февраль по Альфе', () => [run({ tax: 'vat', entityIds: ['alfa'], period: { kind: 'month', year: 2026, month: 2 } })]],
    ['УСН и налог на прибыль за год', () => [run({ tax: 'usn', period: { kind: 'year', year: 2026 } }), run({ tax: 'profit', period: { kind: 'year', year: 2026 } })]],
    ['НДС за 3 квартал', () => [run({ tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 3 } })]],
  ];

  for (const [name, make] of cases) {
    describe(name, () => {
      it('четыре листа с нужными именами', async () => {
        const wb = await load(make());
        expect(wb.worksheets.map((w) => w.name)).toEqual([SHEET_TOTAL, SHEET_MONTHS, SHEET_CALC, SHEET_SOURCE]);
      });

      it('в файле есть формулы, не только значения', async () => {
        const wb = await load(make());
        expect(formulaCells(wb, SHEET_CALC).length).toBeGreaterThan(5);
        expect(formulaCells(wb, SHEET_TOTAL).length).toBeGreaterThan(0);
        expect(formulaCells(wb, SHEET_MONTHS).length).toBeGreaterThan(0);
      });

      it('каждая формула, пересчитанная заново, даёт сохранённое число', async () => {
        const wb = await load(make());
        for (const sheet of [SHEET_CALC, SHEET_MONTHS, SHEET_TOTAL]) {
          for (const c of formulaCells(wb, sheet)) {
            const again = evaluate(wb, sheet, c.address);
            expect(Math.abs(again - c.result), `${sheet}!${c.address} =${c.formula}`).toBeLessThan(1e-6);
          }
        }
      });

      it('итоги юрлиц и группы на листе «Итог» равны CalcResult до копейки', async () => {
        const results = make();
        const wb = await load(results);
        const ws = wb.getWorksheet(SHEET_TOTAL)!;
        // строки таблиц: имя юрлица в колонке A, налог в колонке E, выручка в D
        let ri = -1;
        const seen = new Map<string, number[]>();
        ws.eachRow((row) => {
          const a = String(row.getCell(1).value ?? '');
          if (a === 'Юрлицо' && row.getCell(2).value === 'Режим налогообложения') ri += 1;
          const target = results[Math.max(ri, 0)]!;
          const e = target.entities.find((x) => x.name === a && x.applicable);
          if (e) {
            const tax = evaluate(wb, SHEET_TOTAL, row.getCell(5).address);
            const rev = evaluate(wb, SHEET_TOTAL, row.getCell(4).address);
            expect(tax.toFixed(2)).toBe(e.tax!.toFixed(2));
            expect(rev.toFixed(2)).toBe(e.revenue!.toFixed(2));
            seen.set(`${ri}:${e.entityId}`, [tax, rev]);
          }
          if (a === 'Итого по группе' || a === 'Итого') {
            const tax = evaluate(wb, SHEET_TOTAL, row.getCell(5).address);
            expect(tax.toFixed(2)).toBe(target.total!.toFixed(2));
            const rev = evaluate(wb, SHEET_TOTAL, row.getCell(4).address);
            expect(rev.toFixed(2)).toBe(target.revenue!.toFixed(2));
          }
        });
        const expected = results.reduce((n, r) => n + r.entities.filter((e) => e.applicable).length, 0);
        expect(seen.size).toBe(expected);
      });

      it('названия столбцов шагов распознаны, общих «Вход n» нет', async () => {
        const wb = await load(make());
        const heads: string[] = [];
        wb.getWorksheet(SHEET_CALC)!.eachRow((row) => {
          if (row.getCell(1).value === 'Шаг') row.eachCell((c) => heads.push(String(c.value)));
        });
        expect(heads.length).toBeGreaterThan(0);
        expect(heads.filter((h) => /^(Вход|Ссылка) \d+$/.test(h))).toEqual([]);
      });
    });
  }

  it('источник: метка «Демо-данные», дата выгрузки, период, основа', async () => {
    const wb = await load([run({ tax: 'vat', period: { kind: 'ytd' } })]);
    const ws = wb.getWorksheet(SHEET_SOURCE)!;
    const text: string[] = [];
    ws.eachRow((row) => text.push(row.values ? (row.values as CellVal[]).filter(Boolean).join(' | ') : ''));
    const all = text.join('\n');
    expect(all).toContain('Демо-данные');
    expect(all).toContain('Выгрузка из 1С (демо)');
    expect(all).toContain('10 октября 2026, 18:00');
    expect(all).toContain('факт и прогноз');
    expect(all).toContain('с начала года');
    expect(all).toContain('rate_special_5');
    expect(all).toContain('НК РФ, ст. 164');
  });

  it('значения в файле совпадают с CalcResult по месяцам, юрлицам и группе', async () => {
    const r = run({ tax: 'vat', period: { kind: 'year', year: 2026 } });
    const wb = await load([r]);
    const ws = wb.getWorksheet(SHEET_MONTHS)!;
    const rows: Record<string, number[]> = {};
    ws.eachRow((row) => {
      const name = String(row.getCell(1).value ?? '');
      const month = String(row.getCell(2).value ?? '');
      const e = r.entities.find((x) => x.name === name);
      if (e && month) {
        const m = e.months.find((x) => x.label === month);
        if (m && m.tax !== null) {
          const v = evaluate(wb, SHEET_MONTHS, row.getCell(6).address);
          expect(Math.abs(v - m.tax.toNumber())).toBeLessThan(1e-6);
          (rows[e.entityId] ??= []).push(v);
        }
      }
    });
    expect(Object.keys(rows).sort()).toEqual(['alfa', 'beta', 'delta', 'epsilon', 'gamma']);
    for (const [id, vals] of Object.entries(rows)) {
      expect(vals).toHaveLength(12);
      const sum = vals.reduce((a, b) => a + b, 0);
      // сумма точных месяцев, округлённая один раз, равна итогу юрлица
      expect((Math.round(sum * 100) / 100).toFixed(2)).toBe(r.entities.find((e) => e.entityId === id)!.tax!.toFixed(2));
    }
  });
});

describe('имя файла', () => {
  const snap = (args: Parameters<typeof run>[0]) =>
    toSnapshot(run(args), { at: AT, tz: TZ, scope: args.entityIds ?? 'all' });

  it('налог, юрлицо и период: НДС_Альфа_2026-02.xlsx', () => {
    expect(exportFileName([snap({ tax: 'vat', entityIds: ['alfa'], period: { kind: 'month', year: 2026, month: 2 } })])).toBe(
      'НДС_Альфа_2026-02.xlsx',
    );
  });

  it('группа, год, квартал, с начала года', () => {
    expect(exportFileName([snap({ tax: 'vat', period: { kind: 'year', year: 2026 } })])).toBe('НДС_Группа_2026.xlsx');
    expect(exportFileName([snap({ tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 3 } })])).toBe(
      'НДС_Группа_2026-3-кв.xlsx',
    );
    expect(exportFileName([snap({ tax: 'vat', period: { kind: 'ytd' } })])).toBe(
      'НДС_Группа_с-начала-года-по-2026-10-10.xlsx',
    );
  });

  it('несколько налогов: общее имя', () => {
    const name = exportFileName([
      snap({ tax: 'usn', period: { kind: 'year', year: 2026 } }),
      snap({ tax: 'profit', period: { kind: 'year', year: 2026 } }),
    ]);
    expect(name).toBe('Налог-на-прибыль-и-УСН_Группа_2026.xlsx');
  });
});

import ExcelJS from 'exceljs';
import type { Dec } from '@/lib/calc/decimal';
import { REGIME_LABEL } from '@/lib/calc/income-tax';
import { dateRuYear } from '@/lib/calc/format';
import { formatLoadedAt } from '@/lib/calc/provenance';
import type { FormulaStep } from '@/lib/calc/provenance';
import type { CalcResult, EntityResult } from '@/lib/calc/service';
import { PALETTE } from '@/lib/theme';
import { KIND_LABEL, preciseDateTime, shortDateTime } from '@/lib/provenance/line';
import {
  incomeTaxTitle,
  limitLine,
  thresholdLine,
  unifiedLine,
  verdictLine,
  type WhatIfSnapshot,
} from '@/lib/provenance/whatif';
import { leavesOf, parseExpression, printExcel, signatureOf, type ExprNode, type Leaf } from './excel-formula';

/**
 * Выгрузка расчёта в Excel (.xlsx). Четыре листа:
 *  «Итог»       по юрлицам и по группе; итоги формулами, ссылки на лист «Расчёт»;
 *  «По месяцам» выручка и налог по месяцам и юрлицам, строки группы суммами;
 *  «Расчёт»     каждый шаг формулы расчёта живой формулой Excel: числа шага лежат в отдельных
 *               ячейках (выручка, ставка, доля вычета), результат считает формула;
 *  «Источник»   откуда цифры, дата выгрузки, период, факт или прогноз, юрлицо, правила.
 *
 * Все числа приходят из CalcResult. Файл содержит и посчитанные значения (кэш формул), поэтому
 * цифры видны в любой программе просмотра, а при открытии в Excel формулы пересчитываются.
 */

export const SHEET_TOTAL = 'Итог';
export const SHEET_MONTHS = 'По месяцам';
export const SHEET_CALC = 'Расчёт';
export const SHEET_SOURCE = 'Источник';
export const SHEET_WHATIF = 'Сценарий';

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;
const FILL_HEAD: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.lake) } };
const FILL_INPUT: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.soft) } };
const FILL_TOTAL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.mint) } };
const BORDER: Partial<ExcelJS.Borders> = {
  bottom: { style: 'thin', color: { argb: argb(PALETTE.line) } },
};
const MONEY = '#,##0.00';

const num = (v: Dec): number => v.toNumber();

function colName(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const addr = (col: number, row: number) => `${colName(col)}${row}`;
/** Ссылка на ячейку другого листа: 'Расчёт'!D12 */
const ref = (sheet: string, a: string) => `'${sheet}'!${a}`;

function styleHeader(row: ExcelJS.Row, from: number, to: number): void {
  for (let c = from; c <= to; c++) {
    const cell = row.getCell(c);
    cell.fill = FILL_HEAD;
    cell.font = { bold: true, color: { argb: argb(PALETTE.ink) } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  }
}

// ===== Формы шагов =====

interface Shape {
  title: string;
  /** Названия числовых и ссылочных слотов по порядку; null: назвать по умолчанию */
  slots: string[] | null;
}

const MONTH_TITLES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/**
 * Названия слотов по подписи выражения. Подпись строится из выражений calcTax; если форма
 * неизвестна (расчёт дополнили новым шагом), столбцы называются «Вход 1, Вход 2», формула и
 * значения от этого не страдают.
 */
function shapeOf(sig: string, text: string, leafCount: number): Shape {
  switch (sig) {
    case 'N':
      if (text.startsWith('выручка по факту')) {
        return { title: 'Выручка месяца по факту', slots: ['Выручка с НДС за месяц, ₽'] };
      }
      if (text.startsWith('освобождено')) {
        return { title: 'Месяцы без НДС (освобождение)', slots: ['Налог при освобождении, ₽'] };
      }
      return { title: 'Значение', slots: null };
    case 'N*N/N':
      return {
        title: 'Выручка по факту, месяц не целиком',
        slots: ['Выручка полного месяца, ₽', 'Дней в периоде', 'Дней в месяце'],
      };
    case 'N*N':
      return {
        title: 'Выручка по прогнозу: прогноз года на долю месяца',
        slots: ['Прогноз выручки года, ₽', 'Доля месяца (сезонность)'],
      };
    case 'N*N*N/N':
      return {
        title: 'Выручка по прогнозу, месяц не целиком',
        slots: ['Прогноз выручки года, ₽', 'Доля месяца (сезонность)', 'Дней в периоде', 'Дней в месяце'],
      };
    case 'N*N*N':
      return {
        title: 'Выручка прогноза следующего года: выручка текущего года с ростом на долю месяца',
        slots: ['Выручка текущего года, ₽', 'Коэффициент роста', 'Доля месяца (сезонность)'],
      };
    case 'N*N*N*N/N':
      return {
        title: 'Выручка прогноза следующего года, месяц не целиком',
        slots: ['Выручка текущего года, ₽', 'Коэффициент роста', 'Доля месяца (сезонность)', 'Дней в периоде', 'Дней в месяце'],
      };
    case 'S*N/N':
      return {
        title: 'НДС по месяцам: выручка × ставка / (100 + ставка)',
        slots: ['Выручка месяца с НДС, ₽', 'Ставка НДС, %', 'Ставка плюс 100'],
      };
    case 'S*N/N*(N-N)':
      return {
        title: 'НДС по общей ставке с вычетом: выручка × ставка / (100 + ставка) × (1 − p)',
        slots: ['Выручка месяца с НДС, ₽', 'Ставка НДС, %', 'Ставка плюс 100', 'Единица', 'Доля закупок с входным НДС (p)'],
      };
    case 'N-N*N/N':
      return {
        title: 'Доходы без НДС',
        slots: ['Выручка года с НДС, ₽', 'Выручка, облагаемая НДС, ₽', 'Ставка НДС, %', 'Ставка плюс 100'],
      };
    case 'max(N,S-N)':
      return {
        title: 'База налога (не меньше нуля)',
        slots: ['Нижняя граница', 'Доходы без НДС, ₽', 'Расходы за год без НДС, ₽'],
      };
    case 'S*N':
      if (text.startsWith('минимальный налог')) {
        return { title: 'Минимальный налог', slots: ['Доходы без НДС, ₽', 'Ставка минимального налога (доля)'] };
      }
      return { title: 'Налог за год', slots: ['База налога, ₽', 'Ставка налога (доля)'] };
    case 'max(S,S)':
      return { title: 'Налог за год: большее из двух', slots: ['Налог по ставке, ₽', 'Минимальный налог, ₽'] };
    case 'S*S/S':
      return {
        title: 'Налог месяца: доля налога года по выручке',
        slots: ['Налог за год, ₽', 'Выручка месяца, ₽', 'Выручка года, ₽'],
      };
    case 'N*N+N':
      return {
        title: 'Выручка по сценарию: прогноз месяца на рост плюс добавочная выручка',
        slots: ['Прогноз месяца, ₽', 'Коэффициент роста', 'Добавочная выручка, ₽'],
      };
    case 'N*N-N':
      return {
        title: 'Выручка по сценарию: прогноз месяца на рост минус снижение',
        slots: ['Прогноз месяца, ₽', 'Коэффициент роста', 'Снижение выручки, ₽'],
      };
    case '(N*N+N)*N/N':
    case '(N*N-N)*N/N':
      return {
        title: 'Выручка по сценарию, месяц не целиком',
        slots: ['Прогноз месяца, ₽', 'Коэффициент роста', 'Добавка или снижение, ₽', 'Дней в периоде', 'Дней в месяце'],
      };
    default:
      if (/^N(\+N)+$/.test(sig) && leafCount === 12) {
        return { title: 'Выручка года по месяцам', slots: MONTH_TITLES.slice() };
      }
      if (/^(round2\()?S(\+S)+\)?$/.test(sig)) {
        return { title: text.includes('сумма по юрлицам') ? 'Итог по группе' : 'Суммы за период', slots: null };
      }
      return { title: 'Прочие шаги', slots: null };
  }
}

interface PlacedStep {
  step: FormulaStep;
  ast: ExprNode;
  leaves: Leaf[];
  /** Номер строки на листе «Расчёт» */
  row: number;
}

interface Table {
  key: string;
  title: string;
  slotNames: string[];
  rows: PlacedStep[];
  /** Номер колонки результата: 4 + число слотов */
  resultCol: number;
  textCol: number;
}

interface Layout {
  tables: Table[];
  /** Адрес результата шага */
  where: Map<string, string>;
  /** Следующая свободная строка листа «Расчёт» */
  nextRow: number;
}

/** Ключ шага в общей карте адресов: номер результата и номер шага. */
const stepKey = (resultIdx: number, id: string) => `${resultIdx}:${id}`;

function planResult(result: CalcResult, resultIdx: number, startRow: number, where: Map<string, string>): Layout {
  const byKey = new Map<string, Table>();
  const order: Table[] = [];
  const names = new Map(result.entities.map((e) => [e.entityId, e.name]));
  const monthLabels = new Map(result.months.map((m) => [m.key, m.label]));

  for (const step of result.steps) {
    const ast = parseExpression(step.expression);
    const leaves = leavesOf(ast);
    const sig = signatureOf(ast);
    const shape = shapeOf(sig, step.text, leaves.length);
    // подпись и заголовок вместе дают ключ таблицы: шаги одной формы стоят в одной таблице
    const key = `${sig}|${shape.title}`;
    let t = byKey.get(key);
    if (!t) {
      t = {
        key,
        title: shape.title,
        slotNames: shape.slots ?? leaves.map((l, i) => (l.t === 'ref' ? `Ссылка ${i + 1}` : `Вход ${i + 1}`)),
        rows: [],
        resultCol: 4 + leaves.length,
        textCol: 5 + leaves.length,
      };
      byKey.set(key, t);
      order.push(t);
    }
    t.rows.push({ step, ast, leaves, row: 0 });
  }

  // таблица сумм: слоты называются по тому, что суммируется (месяц или юрлицо)
  const stepById = new Map(result.steps.map((s) => [s.id, s]));
  for (const t of order) {
    if (t.slotNames.every((n) => /^(Вход|Ссылка) \d+$/.test(n)) && t.rows.every((r) => r.leaves.every((l) => l.t === 'ref'))) {
      t.slotNames = t.slotNames.map((_, j) => {
        const labels = new Set(
          t.rows.map((r) => {
            const leaf = r.leaves[j] as { t: 'ref'; id: string };
            const s = stepById.get(leaf.id);
            if (!s) return '';
            if (s.month) return monthLabels.get(s.month) ?? s.month;
            return s.entityId ? (names.get(s.entityId) ?? '') : '';
          }),
        );
        const only = labels.size === 1 ? [...labels][0]! : '';
        return only || `Слагаемое ${j + 1}`;
      });
    }
  }

  // строки: заголовок таблицы, шапка, шаги, пустая строка
  let row = startRow;
  for (const t of order) {
    row += 2;
    for (const r of t.rows) {
      r.row = row++;
      where.set(stepKey(resultIdx, r.step.id), addr(t.resultCol, r.row));
    }
    row += 1;
  }
  return { tables: order, where, nextRow: row };
}

function numFmt(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1000) return '0';
  if (Math.abs(v) >= 1000) return MONEY;
  return '0.0###';
}

function titleOf(result: CalcResult): string {
  // у прогноза следующего года три расчёта одного налога и периода: различаются ставкой
  const forecast = result.scenario ? (result.rate !== null ? `, прогноз по ставке ${result.rate}%` : ', прогноз') : '';
  // сценарий «что если»: расчёт по данным и тот же расчёт при условии сценария
  const what = result.whatIf ? (result.whatIf.role === 'scenario' ? ', по сценарию' : ', сейчас') : '';
  return `${result.taxName}: ${result.periodLabel}${forecast}${what}`;
}

// ===== Книга =====

export interface WorkbookMeta {
  /** Момент расчёта, мс UTC */
  at: number;
  tz: string;
  /** Заголовок листа «Итог» над блоками; по умолчанию из результатов */
  title?: string;
  /** Сценарий «что если»: на лист «Сценарий» выводится сравнение «сейчас и по сценарию» */
  whatIf?: WhatIfSnapshot | null;
}

/** Лист «Итог», «По месяцам», «Расчёт» и «Источник» в уже созданной книге (после листов вызывающего). */
export function addCalcSheets(wb: ExcelJS.Workbook, results: CalcResult[], meta: WorkbookMeta): void {
  if (results.length === 0) throw new Error('Нечего выгружать: нет результатов расчёта');
  const total = wb.addWorksheet(SHEET_TOTAL);
  const months = wb.addWorksheet(SHEET_MONTHS);
  const calc = wb.addWorksheet(SHEET_CALC);
  const source = wb.addWorksheet(SHEET_SOURCE);

  // 1. Раскладка листа «Расчёт»: адреса результатов нужны остальным листам
  const where = new Map<string, string>();
  const layouts: Layout[] = [];
  let calcRow = 4;
  results.forEach((r, i) => {
    calcRow += 1; // заголовок блока
    const layout = planResult(r, i, calcRow, where);
    layouts.push(layout);
    calcRow = layout.nextRow + 1;
  });

  writeCalc(calc, results, layouts, where, meta);
  writeMonths(months, results, where, meta);
  writeTotal(total, results, where, meta);
  writeSource(source, results, meta);
}

/** Новая книга со свойствами приложения; формулы пересчитываются при открытии. */
export function newWorkbook(meta: WorkbookMeta, title: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Агент по НДС';
  wb.title = title;
  wb.created = new Date(meta.at);
  wb.modified = new Date(meta.at);
  // при открытии Excel пересчитывает формулы; значения в файле уже посчитаны приложением
  wb.calcProperties.fullCalcOnLoad = true;
  return wb;
}

export async function buildWorkbook(results: CalcResult[], meta: WorkbookMeta): Promise<Buffer> {
  if (results.length === 0) throw new Error('Нечего выгружать: нет результатов расчёта');
  const wb = newWorkbook(meta, meta.title ?? results.map(titleOf).join('; '));
  // сравнение «сейчас и по сценарию» идёт первым листом: его читают раньше формул
  if (meta.whatIf) addWhatIfSheet(wb, meta.whatIf, meta);
  addCalcSheets(wb, results, meta);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/**
 * Лист «Сценарий»: показатели по юрлицам сейчас и по сценарию, разница формулой, итог по юрлицам
 * сценария суммой. Ниже порог освобождения, доля лимита ставки 5%, признаки единого бизнеса и
 * допущения. Числа из WhatIfSnapshot, то есть те же, что в ответе агента и в панели расчёта.
 */
function addWhatIfSheet(wb: ExcelJS.Workbook, w: WhatIfSnapshot, meta: WorkbookMeta): void {
  const ws = wb.addWorksheet(SHEET_WHATIF);
  sheetIntro(
    ws,
    `Сценарий: ${w.title}, ${w.monthsLabel || `${w.year} год`}`,
    meta,
    'Сценарий, а не прогноз. Данные дашборда не менялись. Разница это формула: по сценарию минус сейчас.',
  );
  [38, 20, 20, 20].forEach((width, i) => (ws.getColumn(i + 1).width = width));
  const money = (v: string | null): number | string => (v === null ? 'нет данных' : Number(v));

  let row = 5;
  const head = ws.getRow(row);
  ['Показатель', 'Сейчас, ₽', 'По сценарию, ₽', 'Разница, ₽'].forEach((h, i) => (head.getCell(i + 1).value = h));
  styleHeader(head, 1, 4);
  row += 1;

  const block = (name: string, rows: { label: string; base: string | null; scenario: string | null }[]): number[] => {
    const nameCell = ws.getCell(row, 1);
    nameCell.value = name;
    nameCell.font = { bold: true, color: { argb: argb(PALETTE.accent) } };
    row += 1;
    const lines: number[] = [];
    for (const r of rows) {
      const x = ws.getRow(row);
      x.getCell(1).value = r.label;
      x.getCell(2).value = money(r.base);
      x.getCell(3).value = money(r.scenario);
      if (r.base !== null && r.scenario !== null) {
        x.getCell(4).value = {
          formula: `${addr(3, row)}-${addr(2, row)}`,
          result: Number(r.scenario) - Number(r.base),
        };
      } else {
        x.getCell(4).value = 'нет данных';
      }
      for (let c = 2; c <= 4; c++) x.getCell(c).numFmt = MONEY;
      for (let c = 1; c <= 4; c++) x.getCell(c).border = BORDER;
      lines.push(row);
      row += 1;
    }
    return lines;
  };

  const taxTitle = (kind: 'usn' | 'profit') => incomeTaxTitle([{ incomeTaxKind: kind }]);
  const perEntity = w.rows.map((r) =>
    block(r.name, [
      { label: 'Выручка за год', ...r.revenue },
      { label: 'НДС за год', ...r.vat },
      { label: taxTitle(r.incomeTaxKind), ...r.incomeTax },
      { label: 'Налоги за год', ...r.taxes },
    ]),
  );

  if (w.rows.length > 1) {
    row += 1;
    const t = w.totals;
    const lines = block('Итого по юрлицам сценария', [
      { label: 'Выручка за год', ...t.revenue },
      { label: 'НДС за год', ...t.vat },
      { label: incomeTaxTitle(w.rows), ...t.incomeTax },
      { label: 'Налоги за год', ...t.taxes },
    ]);
    // итоги суммой строк юрлиц выше
    lines.forEach((line, k) => {
      for (const col of [2, 3]) {
        const parts = perEntity.map((p) => addr(col, p[k]!));
        const sum = parts.reduce((a, c) => a + (typeof ws.getCell(c).value === 'number' ? Number(ws.getCell(c).value) : 0), 0);
        ws.getCell(line, col).value = { formula: `SUM(${parts.join(',')})`, result: sum };
        ws.getCell(line, col).numFmt = MONEY;
      }
      ws.getCell(line, 1).font = { bold: true };
    });
  }

  row += 1;
  const notes: string[] = [];
  for (const r of w.rows) {
    const line = thresholdLine(r, w.year);
    if (line) notes.push(line);
  }
  const limit = limitLine(w.rows);
  if (limit) notes.push(limit);
  const verdict = verdictLine(w);
  if (verdict) notes.push(verdict);
  const unified = unifiedLine(w);
  if (unified) notes.push(unified);
  for (const n of notes) {
    ws.getCell(row, 1).value = n;
    ws.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' };
    ws.mergeCells(row, 1, row, 4);
    ws.getRow(row).height = n.length > 100 ? 32 : 18;
    row += 1;
  }

  row += 1;
  ws.getCell(row, 1).value = 'Допущения';
  ws.getCell(row, 1).font = { bold: true };
  row += 1;
  for (const a of w.assumptions) {
    ws.getCell(row, 1).value = a;
    ws.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' };
    ws.mergeCells(row, 1, row, 4);
    ws.getRow(row).height = a.length > 100 ? 32 : 18;
    row += 1;
  }
}

function sheetIntro(ws: ExcelJS.Worksheet, title: string, meta: WorkbookMeta, note: string): void {
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: argb(PALETTE.ink) } };
  ws.getCell('A2').value = `Файл для проверки расчёта. Расчёт на ${preciseDateTime(meta.at, meta.tz)}.`;
  ws.getCell('A2').font = { bold: true, color: { argb: argb(PALETTE.accent) } };
  ws.getCell('A3').value = note;
  ws.getCell('A3').font = { italic: true, color: { argb: argb(PALETTE.muted) } };
}

function entityName(result: CalcResult, id: string | null): string {
  if (!id) return 'Группа';
  return result.entities.find((e) => e.entityId === id)?.name ?? id;
}

function writeCalc(
  ws: ExcelJS.Worksheet,
  results: CalcResult[],
  layouts: Layout[],
  where: Map<string, string>,
  meta: WorkbookMeta,
): void {
  sheetIntro(
    ws,
    'Расчёт по шагам',
    meta,
    'Жёлтые ячейки это входные числа шага. Результат шага считает формула: измените входное число, и все связанные итоги на листах пересчитаются.',
  );
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 24;
  ws.getColumn(3).width = 16;
  for (let c = 4; c <= 18; c++) ws.getColumn(c).width = 18;

  results.forEach((result, ri) => {
    const layout = layouts[ri]!;
    const first = layout.tables[0]?.rows[0]?.row ?? 6;
    // заголовок блока стоит над первой таблицей
    const blockRow = first - 3;
    const blockCell = ws.getCell(blockRow, 1);
    blockCell.value = results.length > 1 ? `${ri + 1}. ${titleOf(result)}` : titleOf(result);
    blockCell.font = { bold: true, size: 12, color: { argb: argb(PALETTE.ink) } };

    for (const t of layout.tables) {
      const headRow = t.rows[0]!.row - 1;
      const titleRow = headRow - 1;
      ws.getCell(titleRow, 1).value = t.title;
      ws.getCell(titleRow, 1).font = { bold: true, color: { argb: argb(PALETTE.accent) } };
      const head = ws.getRow(headRow);
      head.getCell(1).value = 'Шаг';
      head.getCell(2).value = 'Юрлицо';
      head.getCell(3).value = 'Месяц';
      t.slotNames.forEach((n, j) => {
        head.getCell(4 + j).value = n;
      });
      head.getCell(t.resultCol).value = 'Результат, ₽';
      head.getCell(t.textCol).value = 'Как считается';
      styleHeader(head, 1, t.textCol);
      head.height = 32;

      for (const p of t.rows) {
        const row = ws.getRow(p.row);
        row.getCell(1).value = p.step.id;
        row.getCell(2).value = entityName(result, p.step.entityId);
        row.getCell(3).value = p.step.month
          ? (result.months.find((m) => m.key === p.step.month)?.label ?? p.step.month)
          : 'период';
        const slotCells: string[] = [];
        p.leaves.forEach((leaf, j) => {
          const cell = row.getCell(4 + j);
          slotCells.push(addr(4 + j, p.row));
          if (leaf.t === 'num') {
            const v = Number(leaf.v);
            cell.value = v;
            cell.numFmt = numFmt(v);
            cell.fill = FILL_INPUT;
          } else {
            const target = where.get(stepKey(ri, leaf.id));
            const targetStep = result.steps.find((s) => s.id === leaf.id);
            if (!target || !targetStep) throw new Error(`Шаг ${p.step.id} ссылается на неизвестный шаг ${leaf.id}`);
            cell.value = { formula: target, result: num(targetStep.result) };
            cell.numFmt = MONEY;
          }
        });
        const out = row.getCell(t.resultCol);
        out.value = { formula: printExcel(p.ast, slotCells, { contiguous: true }), result: num(p.step.result) };
        out.numFmt = MONEY;
        out.font = { bold: true };
        out.fill = FILL_TOTAL;
        row.getCell(t.textCol).value = p.step.text;
        for (let c = 1; c <= t.textCol; c++) row.getCell(c).border = BORDER;
      }
    }
  });
  ws.getColumn(30).width = 60;
}

function writeMonths(
  ws: ExcelJS.Worksheet,
  results: CalcResult[],
  where: Map<string, string>,
  meta: WorkbookMeta,
): void {
  sheetIntro(
    ws,
    'Выручка и налог по месяцам',
    meta,
    'Суммы по месяцам хранятся точно, на экране и в файле показаны с копейками. Итог за период округляется один раз, поэтому сумма показанных месяцев может отличаться от итога на копейки.',
  );
  const widths = [26, 18, 16, 16, 20, 20, 24];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  let row = 5;
  results.forEach((result, ri) => {
    const bt = ws.getCell(row, 1);
    bt.value = results.length > 1 ? `${ri + 1}. ${titleOf(result)}` : titleOf(result);
    bt.font = { bold: true, size: 12, color: { argb: argb(PALETTE.ink) } };
    row += 1;

    const head = ws.getRow(row);
    ['Юрлицо', 'Месяц', 'Основа', 'Доля месяца в периоде', 'Выручка с НДС, ₽', `${result.taxName}, ₽`, 'Строка источника обновлена'].forEach(
      (h, i) => (head.getCell(i + 1).value = h),
    );
    styleHeader(head, 1, 7);
    head.height = 32;
    row += 1;

    // адреса ячеек выручки и налога по месяцу для сумм группы
    const monthRevenue = new Map<string, string[]>();
    const monthTax = new Map<string, string[]>();
    const applicable = result.entities.filter((e) => e.applicable);

    for (const e of applicable) {
      for (const m of e.months) {
        const r = ws.getRow(row);
        r.getCell(1).value = e.name;
        r.getCell(2).value = m.label;
        r.getCell(3).value = m.basis === null ? 'нет данных' : m.status === 'partial' ? 'идёт' : m.exempt ? 'освобождено' : m.basis === 'fact' ? 'факт' : 'прогноз';
        r.getCell(4).value = num(m.coverage);
        r.getCell(4).numFmt = '0.0000';
        const putStep = (col: number, stepId: string | null, value: Dec | null, bucket: Map<string, string[]>) => {
          const cell = r.getCell(col);
          const target = stepId ? where.get(stepKey(ri, stepId)) : undefined;
          if (target && value !== null) {
            cell.value = { formula: ref(SHEET_CALC, target), result: num(value) };
            cell.numFmt = MONEY;
            const list = bucket.get(m.key) ?? [];
            list.push(addr(col, row));
            bucket.set(m.key, list);
          } else {
            cell.value = 'нет данных';
            cell.font = { color: { argb: argb(PALETTE.muted) } };
          }
        };
        putStep(5, m.revenueStep, m.revenue, monthRevenue);
        putStep(6, m.taxStep, m.tax, monthTax);
        r.getCell(7).value = m.updatedAt ? shortDateTime(Date.parse(m.updatedAt), meta.tz) : 'прогноз';
        for (let c = 1; c <= 7; c++) r.getCell(c).border = BORDER;
        row += 1;
      }
    }

    // группа по месяцам: суммы ячеек юрлиц выше
    row += 1;
    const gh = ws.getRow(row);
    ['Группа по месяцам', 'Основа', '', '', 'Выручка с НДС, ₽', `${result.taxName}, ₽`].forEach((h, i) => {
      gh.getCell(i + 1).value = h;
    });
    styleHeader(gh, 1, 6);
    row += 1;
    for (const m of result.months) {
      const r = ws.getRow(row);
      r.getCell(1).value = m.label;
      r.getCell(2).value = m.status === 'partial' ? 'идёт' : m.status === 'fact' ? 'факт' : 'прогноз';
      const put = (col: number, bucket: Map<string, string[]>, value: Dec | null) => {
        const cells = bucket.get(m.key);
        const cell = r.getCell(col);
        if (cells && cells.length === applicable.length && value !== null) {
          cell.value = { formula: cells.join('+'), result: num(value) };
          cell.numFmt = MONEY;
        } else {
          cell.value = 'нет данных';
        }
      };
      put(5, monthRevenue, m.revenue);
      put(6, monthTax, m.tax);
      for (let c = 1; c <= 6; c++) r.getCell(c).border = BORDER;
      row += 1;
    }
    row += 2;
  });
}

function writeTotal(
  ws: ExcelJS.Worksheet,
  results: CalcResult[],
  where: Map<string, string>,
  meta: WorkbookMeta,
): void {
  const title =
    meta.title ?? (results.length === 1 ? titleOf(results[0]!) : results.map((r) => r.taxName).join(' и '));
  sheetIntro(
    ws,
    title,
    meta,
    'Итоги формулами: налог юрлица берётся с листа «Расчёт», итог по группе это сумма налогов юрлиц, каждый уже округлён до копеек.',
  );
  const widths = [30, 30, 18, 22, 22, 20];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  let row = 5;
  results.forEach((result, ri) => {
    const bt = ws.getCell(row, 1);
    bt.value = results.length > 1 ? `${ri + 1}. ${titleOf(result)}` : titleOf(result);
    bt.font = { bold: true, size: 12, color: { argb: argb(PALETTE.ink) } };
    row += 1;

    const head = ws.getRow(row);
    ['Юрлицо', 'Режим налогообложения', 'Ставка НДС, %', 'Выручка с НДС, ₽', `${result.taxName}, ₽`, 'Основа данных'].forEach(
      (h, i) => (head.getCell(i + 1).value = h),
    );
    styleHeader(head, 1, 6);
    head.height = 32;
    row += 1;

    const applicable = result.entities.filter((e) => e.applicable);
    const firstRow = row;
    for (const e of applicable) {
      const r = ws.getRow(row);
      r.getCell(1).value = e.name;
      r.getCell(2).value = REGIME_LABEL[e.regime];
      if (e.rate !== null) r.getCell(3).value = e.rate;
      else r.getCell(3).value = 'разные';
      writeEntityAmount(r.getCell(4), e, 'revenue', ri, where);
      writeEntityAmount(r.getCell(5), e, 'tax', ri, where);
      r.getCell(6).value = KIND_LABEL[e.kind];
      for (let c = 1; c <= 6; c++) r.getCell(c).border = BORDER;
      row += 1;
    }
    const lastRow = row - 1;

    const t = ws.getRow(row);
    t.getCell(1).value =
      result.entities.length > 1 && applicable.length === result.entities.length ? 'Итого по группе' : 'Итого';
    const putTotal = (col: number, value: Dec | null) => {
      const cell = t.getCell(col);
      if (value !== null && applicable.length > 0) {
        cell.value = { formula: `SUM(${addr(col, firstRow)}:${addr(col, lastRow)})`, result: num(value) };
        cell.numFmt = MONEY;
      } else {
        cell.value = 'не рассчитано';
      }
    };
    putTotal(4, result.revenue);
    putTotal(5, result.total);
    t.getCell(6).value = KIND_LABEL[result.kind];
    for (let c = 1; c <= 6; c++) {
      t.getCell(c).font = { bold: true };
      t.getCell(c).fill = FILL_TOTAL;
    }
    row += 1;

    const skipped = result.entities.filter((e) => !e.applicable);
    for (const e of skipped) {
      ws.getCell(row, 1).value = `${e.name}: ${result.taxName.toLowerCase()} для режима «${REGIME_LABEL[e.regime]}» не считается, в итог не входит`;
      ws.getCell(row, 1).font = { color: { argb: argb(PALETTE.muted) } };
      row += 1;
    }
    for (const w of result.warnings.filter((x) => x.kind === 'no_rules' || x.kind === 'no_data' || x.kind === 'no_fact')) {
      ws.getCell(row, 1).value = w.text;
      ws.getCell(row, 1).font = { color: { argb: argb(PALETTE.muted) } };
      row += 1;
    }
    row += 2;
  });
}

function writeEntityAmount(
  cell: ExcelJS.Cell,
  e: EntityResult,
  field: 'revenue' | 'tax',
  resultIdx: number,
  where: Map<string, string>,
): void {
  const value = e[field];
  const stepId = field === 'revenue' ? e.revenueStep : e.taxStep;
  const target = stepId ? where.get(stepKey(resultIdx, stepId)) : undefined;
  if (value !== null && target) {
    cell.value = { formula: ref(SHEET_CALC, target), result: num(value) };
    cell.numFmt = MONEY;
  } else if (value !== null) {
    cell.value = num(value);
    cell.numFmt = MONEY;
  } else {
    cell.value = 'нет данных';
  }
}

function writeSource(ws: ExcelJS.Worksheet, results: CalcResult[], meta: WorkbookMeta): void {
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 60;
  for (let c = 3; c <= 7; c++) ws.getColumn(c).width = 22;
  const first = results[0]!;
  const src = first.source;

  ws.getCell('A1').value = 'Источник данных и параметры расчёта';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: argb(PALETTE.ink) } };

  let row = 3;
  const kv = (k: string, v: string, bold = false) => {
    ws.getCell(row, 1).value = k;
    ws.getCell(row, 1).font = { bold: true };
    ws.getCell(row, 2).value = v;
    if (bold) ws.getCell(row, 2).font = { bold: true, color: { argb: argb(PALETTE.accent) } };
    ws.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' };
    row += 1;
  };

  // Только то, что нужно, чтобы проверить откуда цифры: источник, дата выгрузки, период, основа,
  // юрлицо. Технического кода источника, часового пояса и служебной даты расчёта здесь нет.
  kv('Источник', src ? src.title : 'не указан');
  kv('Дата выгрузки', src ? formatLoadedAt(src.loadedAt, meta.tz) : '');
  row += 1;

  results.forEach((r, i) => {
    kv(results.length > 1 ? `Результат ${i + 1}` : 'Результат', titleOf(r), true);
    kv('Период', r.periodLabel);
    kv('Факт или прогноз', KIND_LABEL[r.kind]);
    kv('Юрлицо', r.entities.filter((e) => e.applicable).map((e) => e.name).join(', ') || 'нет');
    // допущения прогноза: что принято, потому что точных данных нет
    r.assumptions.forEach((a, k) => kv(k === 0 ? 'Допущения' : '', a));
    row += 1;
  });

  const rules = new Map<string, CalcResult['rules'][number]>();
  for (const r of results) for (const x of r.rules) rules.set(`${x.key}|${x.validFrom}`, x);
  if (rules.size > 0) {
    ws.getCell(row, 1).value = 'Применённые правила';
    ws.getCell(row, 1).font = { bold: true, size: 12 };
    row += 1;
    const head = ws.getRow(row);
    ['Правило', 'Значение или формула', 'Норма', 'Действует с', 'Действует по', 'Примечание'].forEach((h, i) => {
      head.getCell(i + 1).value = h;
    });
    styleHeader(head, 1, 6);
    row += 1;
    for (const x of rules.values()) {
      const r = ws.getRow(row);
      r.getCell(1).value = x.key;
      r.getCell(2).value = x.value !== null ? `${x.value} (${x.unit})` : (x.formula ?? '');
      r.getCell(3).value = x.norm ?? '';
      r.getCell(4).value = x.validFrom;
      r.getCell(5).value = x.validTo ?? '';
      r.getCell(6).value = x.note ?? '';
      for (let c = 1; c <= 6; c++) r.getCell(c).border = BORDER;
      row += 1;
    }
  }
}

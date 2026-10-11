import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell as DocxCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import type { CalcResult } from '@/lib/calc/service';
import { addCalcSheets, newWorkbook } from '@/lib/export/xlsx';
import { fromSnapshot, type CalcSnapshot } from '@/lib/provenance/snapshot';
import { PALETTE } from '@/lib/theme';
import { segsText, type RenderBlock, type Seg } from './render';
import { DRAFT_WATERMARK, SAMPLE_NOTE } from './types';

/**
 * Файлы документа. Договоры и отчёты это .docx, проекты деклараций .xlsx. Файл строится из тех же
 * блоков, что и предпросмотр, и из тех же значений версии, поэтому суммы в нём совпадают с экраном.
 */

export interface FileMeta {
  title: string;
  version: number;
  hash: string;
  /** Момент расчёта документа (мс), для свойств файла */
  at: number;
  tz: string;
}

const ARGB = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

// ===== .docx =====

function runs(segs: Seg[], bold = false): TextRun[] {
  return segs.map((s) => {
    if (s.t === 'text') return new TextRun({ text: s.text, bold: bold || undefined });
    // пропущенное поле выделено жёлтым, чтобы его нельзя было пропустить при чтении
    return new TextRun({
      text: s.text,
      bold: bold || undefined,
      highlight: s.state === 'missing' ? 'yellow' : undefined,
    });
  });
}

function cell(text: string, header = false): DocxCell {
  return new DocxCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: header, size: 20 })] })],
    shading: header ? { type: ShadingType.CLEAR, fill: PALETTE.lake.replace('#', ''), color: 'auto' } : undefined,
  });
}

export async function buildDocx(blocks: RenderBlock[], meta: FileMeta): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const b of blocks) {
    if (b.kind === 'table') {
      const rows = [
        new TableRow({ tableHeader: true, children: b.head.map((h) => cell(h, true)) }),
        ...b.rows.map((r) => new TableRow({ children: r.map((c) => cell(c.text)) })),
      ];
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
    } else if (b.kind === 'h1') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs(b.segs, true), spacing: { after: 160 } }));
    } else if (b.kind === 'h2') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(b.segs, true), spacing: { before: 200, after: 100 } }));
    } else if (b.kind === 'li') {
      children.push(new Paragraph({ bullet: { level: 0 }, children: runs(b.segs), spacing: { after: 60 } }));
    } else {
      // перевод строки внутри длинного поля сохраняется
      const text = segsText(b.segs);
      if (text.includes('\n')) {
        const lines = text.split('\n');
        children.push(
          new Paragraph({
            children: lines.map((l, i) => new TextRun({ text: l, break: i > 0 ? 1 : 0 })),
            spacing: { after: 100 },
          }),
        );
      } else {
        children.push(new Paragraph({ children: runs(b.segs), spacing: { after: 100 } }));
      }
    }
  }

  const doc = new Document({
    creator: 'Агент по НДС (демо)',
    title: meta.title,
    description: `${SAMPLE_NOTE}. Демо-данные. Версия ${meta.version}`,
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: `${SAMPLE_NOTE} · Демо-данные`, italics: true, size: 18 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.LEFT,
                children: [
                  new TextRun({ text: `Версия ${meta.version} · контрольная сумма ${meta.hash.slice(0, 12)}`, size: 16 }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ===== .xlsx (проекты деклараций) =====

/**
 * Лист «Проект декларации» с показателями и водяным знаком «Проект. Не для подачи», дальше листы
 * расчёта («Итог», «По месяцам», «Расчёт», «Источник») с живыми формулами: сумма в проекте и на
 * листах расчёта одна и та же.
 */
export async function buildDeclarationXlsx(
  blocks: RenderBlock[],
  snaps: CalcSnapshot[],
  meta: FileMeta,
): Promise<Buffer> {
  const wb = newWorkbook({ at: meta.at, tz: meta.tz }, meta.title);
  const ws = wb.addWorksheet('Проект декларации');
  ws.getColumn(1).width = 52;
  ws.getColumn(2).width = 24;
  ws.getColumn(3).width = 20;
  ws.getColumn(4).width = 20;
  ws.headerFooter.oddHeader = `&C&"Arial,Bold"&14${DRAFT_WATERMARK}`;
  ws.headerFooter.oddFooter = `&L${SAMPLE_NOTE}&RВерсия ${meta.version}`;

  let row = 1;
  const mark = ws.getCell(row, 1);
  mark.value = DRAFT_WATERMARK;
  mark.font = { bold: true, size: 16, color: { argb: ARGB(PALETTE.wine) } };
  ws.mergeCells(row, 1, row, 4);
  row += 1;
  const note = ws.getCell(row, 1);
  note.value = `${SAMPLE_NOTE}. Демо-данные: цифры выдуманы. Версия ${meta.version}, контрольная сумма ${meta.hash.slice(0, 12)}.`;
  note.font = { italic: true, color: { argb: ARGB(PALETTE.muted) } };
  ws.mergeCells(row, 1, row, 4);
  row += 2;

  for (const b of blocks) {
    if (b.kind === 'table') {
      b.head.forEach((h, i) => {
        const c = ws.getCell(row, i + 1);
        c.value = h;
        c.font = { bold: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB(PALETTE.lake) } };
      });
      row += 1;
      for (const r of b.rows) {
        r.forEach((c, i) => {
          const cellRef = ws.getCell(row, i + 1);
          if (c.money && c.amount !== undefined) {
            cellRef.value = Number(c.amount);
            cellRef.numFmt = '#,##0.00';
          } else {
            cellRef.value = c.text;
          }
        });
        row += 1;
      }
      row += 1;
    } else if (b.kind === 'h1' || b.kind === 'h2') {
      const c = ws.getCell(row, 1);
      c.value = segsText(b.segs);
      c.font = { bold: true, size: b.kind === 'h1' ? 14 : 12, color: { argb: ARGB(PALETTE.ink) } };
      ws.mergeCells(row, 1, row, 4);
      row += 1;
    } else {
      // строка с одной суммой: подпись слева, число справа, чтобы сумма была числом, а не текстом
      const fieldsHere = b.segs.filter((s): s is Extract<Seg, { t: 'field' }> => s.t === 'field');
      const money = fieldsHere.length === 1 && fieldsHere[0]!.type === 'money' && fieldsHere[0]!.value !== null;
      if (money) {
        const f = fieldsHere[0]!;
        const label = b.segs
          .filter((s) => s.t === 'text')
          .map((s) => (s as { text: string }).text)
          .join('')
          .replace(/[:\s]+$/, '');
        ws.getCell(row, 1).value = label;
        const n = ws.getCell(row, 2);
        n.value = Number(f.value);
        n.numFmt = '#,##0.00';
        n.font = { bold: true };
      } else {
        const c = ws.getCell(row, 1);
        c.value = segsText(b.segs);
        c.alignment = { wrapText: true, vertical: 'top' };
        if (b.segs.some((s) => s.t === 'field' && s.state === 'missing')) {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB(PALETTE.lemon) } };
        }
        ws.mergeCells(row, 1, row, 4);
      }
      row += 1;
    }
  }

  const results: CalcResult[] = snaps.map(fromSnapshot);
  if (results.length > 0) addCalcSheets(wb, results, { at: meta.at, tz: meta.tz });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

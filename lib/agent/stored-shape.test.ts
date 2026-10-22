import { describe, expect, it } from 'vitest';
import {
  cleanChange,
  cleanForm,
  cleanHow,
  cleanProvenance,
  cleanQuick,
  cleanTables,
  cleanUnderstood,
} from './stored-shape';

const U = { entity: 'ООО «Альфа»', tax: 'НДС', period: 'февраль 2026', kind: 'month', kindLabel: 'факт', notes: ['юрлицо не названо'] };
const Q = { label: 'Альфа', text: 'по Альфе', group: 'entity' as const };

describe('сохранённые сообщения чата: приведение к виду разметки', () => {
  it('целые и верные поля остаются как есть', () => {
    const tables = [{ head: ['a', 'b'], rows: [['x', 'y']], best: [[0, 1]] as [number, number][], totalRow: true, dense: false }];
    expect(cleanTables(tables)).toEqual(tables);
    expect(cleanHow(['строка', 'ещё'])).toEqual(['строка', 'ещё']);
    expect(cleanQuick([Q, { label: 'без вида', text: 'x' }])).toEqual([Q, { label: 'без вида', text: 'x' }]);
    expect(cleanUnderstood(U)).toEqual(U);
    expect(cleanChange({ entity: [Q], tax: [], period: [] })).toEqual({ entity: [Q], tax: [], period: [] });
  });

  it('карточка «Понял так» без списка допущений получает пустой список, без текста полей отбрасывается', () => {
    const { notes: _notes, ...old } = U;
    expect(cleanUnderstood(old)?.notes).toEqual([]);
    expect(cleanUnderstood({})).toBeNull();
    expect(cleanUnderstood(null)).toBeNull();
    expect(cleanUnderstood('текст')).toBeNull();
    expect(cleanUnderstood({ ...U, entity: 5 })).toBeNull();
  });

  it('«Изменить» с недостающими списками получает пустые, не объект отбрасывается', () => {
    expect(cleanChange({ entity: [Q] })).toEqual({ entity: [Q], tax: [], period: [] });
    expect(cleanChange({ entity: [null], tax: 'x', period: undefined })).toEqual({ entity: [], tax: [], period: [] });
    expect(cleanChange(null)).toBeNull();
    expect(cleanChange([])).toBeNull();
  });

  it('кнопки без текста и пустые места отбрасываются, лишний вид группы убирается', () => {
    expect(cleanQuick([null, 3, { text: 'x' }, { label: 'y' }, { label: 'a', text: 'b', group: 'другое' }])).toEqual([
      { label: 'a', text: 'b' },
    ]);
    expect(cleanQuick('x')).toEqual([]);
    expect(cleanQuick(undefined)).toEqual([]);
  });

  it('таблицы: негодные отбрасываются, ячейки приводятся к тексту, лишние поля не мешают', () => {
    expect(cleanTables([{}, null, 'x', { head: ['a'], rows: null }, { head: null, rows: [] }])).toEqual([]);
    expect(cleanTables([{ head: ['a', 'b'], rows: [['x', 3, null], 'str', ['y']] }])).toEqual([
      { head: ['a', 'b'], rows: [['x', '3', ''], ['y']] },
    ]);
    expect(cleanTables([{ head: ['a'], rows: [], best: [[0, 1], [1], ['a', 'b']] }])).toEqual([
      { head: ['a'], rows: [], best: [[0, 1]] },
    ]);
    expect(cleanTables('x')).toEqual([]);
  });

  it('«Как посчитано»: только строки', () => {
    expect(cleanHow('abc')).toEqual([]);
    expect(cleanHow([null, 3, 'ok'])).toEqual(['ok']);
    expect(cleanHow(undefined)).toEqual([]);
  });

  it('карточка с полями и строка происхождения: только целые', () => {
    const form = {
      mode: 'ask',
      values: { entityId: null },
      missing: [],
      confirmVat: false,
      entities: [],
      months: [],
      quick: { cost: [], rent: [] },
      note: null,
    };
    expect(cleanForm(form)).toBe(form);
    expect(cleanForm({})).toBeNull();
    expect(cleanForm({ ...form, values: null })).toBeNull();
    expect(cleanForm({ ...form, mode: 'x' })).toBeNull();
    expect(cleanForm({ ...form, quick: {} })).toBeNull();
    expect(cleanForm('x')).toBeNull();
    const prov = { line: { a: 1 }, count: 1 };
    expect(cleanProvenance(prov)).toBe(prov);
    expect(cleanProvenance({})).toBeNull();
    expect(cleanProvenance({ line: null })).toBeNull();
    expect(cleanProvenance(null)).toBeNull();
  });
});

import type { PeriodKind } from '@/lib/calc/period';
import { momentFromEpoch } from '@/lib/calc/time';
import type { CalcSnapshot } from './snapshot';

/**
 * Строка происхождения под итоговой суммой:
 * «Выгрузка из 1С (демо) · ООО «Альфа» · февраль 2026 · обновлено 10.10.2026 18:00 · факт».
 * Все поля берутся из снимков CalcResult; метку «Демо-данные» рисует компонент рядом со строкой.
 */

export const KIND_LABEL: Record<PeriodKind, string> = {
  fact: 'факт',
  forecast: 'прогноз',
  mixed: 'факт и прогноз',
};

export const DEMO_LABEL = 'Демо-данные';

export interface SourceLineData {
  /** Название источника; null, если источник в базе не заведён */
  source: string | null;
  isDemo: boolean;
  /** «ООО «Альфа»», «Вся группа» */
  scope: string;
  /** «февраль 2026», «с начала года, прогноз на 2026 год» */
  period: string;
  /** Время обновления данных, уже в часовом поясе приложения: «10.10.2026 18:00» */
  updated: string | null;
  kind: PeriodKind;
  /** Пометка в конце строки: «условный расчёт, налог не начисляется» */
  note?: string;
}

/** «10.10.2026 18:00» в часовом поясе приложения. */
export function shortDateTime(epochMs: number, tz: string): string {
  const m = momentFromEpoch(epochMs, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  const sec = Math.floor(m.secondsOfDay);
  return `${p(m.day)}.${p(m.month + 1)}.${m.year} ${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}`;
}

/** «10.10.2026 18:42:07»: момент расчёта с секундами. */
export function preciseDateTime(epochMs: number, tz: string): string {
  const m = momentFromEpoch(epochMs, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  const sec = Math.floor(m.secondsOfDay);
  return `${p(m.day)}.${p(m.month + 1)}.${m.year} ${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

/** Обновление данных: самая поздняя отметка строк факта, иначе дата загрузки источника. */
function updatedOf(snaps: CalcSnapshot[]): number | null {
  let best: number | null = null;
  for (const s of snaps) {
    for (const e of s.entities) {
      for (const m of e.months) {
        if (!m.updatedAt) continue;
        const t = Date.parse(m.updatedAt);
        if (Number.isFinite(t) && (best === null || t > best)) best = t;
      }
    }
  }
  if (best !== null) return best;
  for (const s of snaps) {
    if (s.source) {
      const t = Date.parse(s.source.loadedAt);
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
  }
  return best;
}

/** Период в строке: один период как есть, «с начала года» вместе с годом это текущий год и прогноз. */
export function periodPhrase(snaps: CalcSnapshot[]): string {
  const labels: string[] = [];
  for (const s of snaps) if (!labels.includes(s.periodLabel)) labels.push(s.periodLabel);
  if (labels.length <= 1) return labels[0] ?? '';
  const ytd = snaps.find((s) => s.period.kind === 'ytd');
  const year = snaps.find((s) => s.period.kind === 'year');
  if (ytd && year && labels.length === 2) return `${ytd.periodLabel}, прогноз на ${year.periodLabel}`;
  return labels.join(', ');
}

/** Юрлица в строке: «Вся группа», названия или семейство режима, если названий много. */
export function scopeLabel(snaps: CalcSnapshot[]): string {
  const names: string[] = [];
  const picked = new Set<string>();
  let wholeGroup = snaps.length > 0;
  for (const s of snaps) {
    if (s.scope !== 'all') wholeGroup = false;
    for (const e of s.entities) {
      picked.add(e.entityId);
      if (e.applicable && !names.includes(e.name)) names.push(e.name);
    }
  }
  if (names.length === 0) return wholeGroup ? 'Вся группа' : '';
  if (wholeGroup && names.length === picked.size) return picked.size === 1 ? names[0]! : 'Вся группа';
  const taxes = new Set(snaps.map((s) => s.tax));
  if (names.length > 3 && taxes.size === 1) {
    return taxes.has('usn') ? 'Юрлица на УСН' : taxes.has('profit') ? 'Юрлица на ОСНО' : 'Несколько юрлиц';
  }
  return names.join(names.length === 2 ? ' и ' : ', ');
}

/** Признак основы по всем снимкам: все факт, все прогноз или смесь. */
export function combinedKind(snaps: CalcSnapshot[]): PeriodKind {
  const kinds = new Set<PeriodKind>();
  for (const s of snaps) {
    for (const e of s.entities) {
      if (e.applicable && e.months.length > 0) kinds.add(e.kind);
    }
  }
  if (kinds.size === 0) return snaps[0]?.kind ?? 'forecast';
  if (kinds.size === 1) return [...kinds][0]!;
  return 'mixed';
}

/** Данные строки по одному или нескольким снимкам. tz берётся из снимка. */
export function lineFromSnapshots(snaps: CalcSnapshot[], opts: { note?: string } = {}): SourceLineData {
  const first = snaps[0];
  if (!first) {
    return { source: null, isDemo: true, scope: '', period: '', updated: null, kind: 'forecast' };
  }
  const updated = updatedOf(snaps);
  return {
    source: first.source?.title ?? null,
    isDemo: first.source?.isDemo ?? true,
    scope: scopeLabel(snaps),
    period: periodPhrase(snaps),
    updated: updated === null ? null : shortDateTime(updated, first.tz),
    kind: combinedKind(snaps),
    ...(opts.note ? { note: opts.note } : {}),
  };
}

/** Строка одним текстом, без метки «Демо-данные». */
export function sourceLineText(d: SourceLineData): string {
  const parts = [
    d.source ?? 'Источник не указан',
    d.scope,
    d.period,
    d.updated ? `обновлено ${d.updated}` : null,
    KIND_LABEL[d.kind],
    d.note ?? null,
  ].filter((p): p is string => Boolean(p));
  return parts.join(' · ');
}

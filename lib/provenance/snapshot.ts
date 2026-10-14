import { dec, type Dec } from '@/lib/calc/decimal';
import type { MonthStatus, Period, PeriodKind } from '@/lib/calc/period';
import type { FormulaStep, RuleRef, SourceRef } from '@/lib/calc/provenance';
import type { CalcResult, CalcWarning, ScenarioInfo, TaxKind } from '@/lib/calc/service';
import type { TaxRegime, VatStatus, WhatIfLabel } from '@/lib/calc/types';
import type { WhatIfSnapshot } from './whatif';

/**
 * Снимок результата расчёта для передачи по сети и хранения в базе: те же поля, что у CalcResult,
 * деньги строками (Decimal в JSON не переживает). Ни одного числа здесь не пересчитывается:
 * снимок только переупаковывает CalcResult, а fromSnapshot возвращает его обратно.
 */

export interface SnapshotMonth {
  year: number;
  month: number;
  key: string;
  label: string;
  status: MonthStatus;
  coverage: string;
  basis: 'fact' | 'forecast' | null;
  revenue: string | null;
  tax: string | null;
  exempt: boolean;
  sourceId: string | null;
  updatedAt: string | null;
  revenueStep: string | null;
  taxStep: string | null;
}

export interface SnapshotEntity {
  entityId: string;
  name: string;
  regime: TaxRegime;
  vatStatus: VatStatus;
  applicable: boolean;
  rate: number | null;
  revenue: string | null;
  tax: string | null;
  kind: PeriodKind;
  months: SnapshotMonth[];
  revenueStep: string | null;
  taxStep: string | null;
}

export interface SnapshotStep {
  id: string;
  label: string;
  text: string;
  expression: string;
  result: string;
  entityId: string | null;
  month: string | null;
}

export interface SnapshotGroupMonth {
  key: string;
  label: string;
  status: MonthStatus;
  coverage: string;
  revenue: string | null;
  tax: string | null;
}

export interface CalcSnapshot {
  v: 1;
  tax: TaxKind;
  taxName: string;
  period: Period;
  periodLabel: string;
  from: string;
  to: string;
  rate: number | null;
  total: string | null;
  revenue: string | null;
  entities: SnapshotEntity[];
  months: SnapshotGroupMonth[];
  steps: SnapshotStep[];
  totalStep: string | null;
  revenueStep: string | null;
  rules: RuleRef[];
  source: SourceRef | null;
  asOf: string;
  kind: PeriodKind;
  warnings: CalcWarning[];
  /** Допущения расчёта. У снимков, сохранённых до сценариев, поля нет */
  assumptions?: string[];
  /** Сценарий прогноза; у расчёта по данным null или поля нет */
  scenario?: ScenarioInfo | null;
  /** Сценарий «что если»: расчёт «сейчас» или «по сценарию»; у остальных расчётов поля нет */
  whatIf?: WhatIfLabel | null;
  /** Сравнение «сейчас и по сценарию»: хранится у одного расчёта набора */
  comparison?: WhatIfSnapshot | null;
  /** Момент, на который посчитано, мс UTC. На экране в этот момент стояли те же цифры */
  at: number;
  /** Часовой пояс приложения: время загрузки источника и момент расчёта показываются в нём */
  tz: string;
  /** Юрлица запроса: 'all' для группы или список id */
  scope: string[] | 'all';
}

const s = (v: Dec | null): string | null => (v === null ? null : v.toString());

export function toSnapshot(
  r: CalcResult,
  meta: { at: number; tz: string; scope: string[] | 'all'; comparison?: WhatIfSnapshot | null },
): CalcSnapshot {
  return {
    v: 1,
    tax: r.tax,
    taxName: r.taxName,
    period: r.period,
    periodLabel: r.periodLabel,
    from: r.from,
    to: r.to,
    rate: r.rate,
    total: s(r.total),
    revenue: s(r.revenue),
    entities: r.entities.map((e) => ({
      entityId: e.entityId,
      name: e.name,
      regime: e.regime,
      vatStatus: e.vatStatus,
      applicable: e.applicable,
      rate: e.rate,
      revenue: s(e.revenue),
      tax: s(e.tax),
      kind: e.kind,
      revenueStep: e.revenueStep,
      taxStep: e.taxStep,
      months: e.months.map((m) => ({
        year: m.year,
        month: m.month,
        key: m.key,
        label: m.label,
        status: m.status,
        coverage: m.coverage.toString(),
        basis: m.basis,
        revenue: s(m.revenue),
        tax: s(m.tax),
        exempt: m.exempt,
        sourceId: m.sourceId,
        updatedAt: m.updatedAt,
        revenueStep: m.revenueStep,
        taxStep: m.taxStep,
      })),
    })),
    months: r.months.map((m) => ({
      key: m.key,
      label: m.label,
      status: m.status,
      coverage: m.coverage.toString(),
      revenue: s(m.revenue),
      tax: s(m.tax),
    })),
    steps: r.steps.map((st) => ({
      id: st.id,
      label: st.label,
      text: st.text,
      expression: st.expression,
      result: st.result.toString(),
      entityId: st.entityId,
      month: st.month,
    })),
    totalStep: r.totalStep,
    revenueStep: r.revenueStep,
    rules: r.rules,
    source: r.source,
    asOf: r.asOf,
    kind: r.kind,
    warnings: r.warnings,
    assumptions: r.assumptions,
    scenario: r.scenario,
    ...(r.whatIf ? { whatIf: r.whatIf } : {}),
    ...(meta.comparison ? { comparison: meta.comparison } : {}),
    at: meta.at,
    tz: meta.tz,
    scope: meta.scope,
  };
}

const d = (v: string | null): Dec | null => (v === null ? null : dec(v));

/** Обратное преобразование: CalcResult с Decimal. Нужно серверу, чтобы выгрузить Excel из снимка. */
export function fromSnapshot(snap: CalcSnapshot): CalcResult {
  const steps: FormulaStep[] = snap.steps.map((st) => ({
    id: st.id,
    label: st.label,
    text: st.text,
    expression: st.expression,
    result: dec(st.result),
    entityId: st.entityId,
    month: st.month,
  }));
  return {
    tax: snap.tax,
    taxName: snap.taxName,
    period: snap.period,
    periodLabel: snap.periodLabel,
    from: snap.from,
    to: snap.to,
    rate: snap.rate,
    total: d(snap.total),
    revenue: d(snap.revenue),
    entities: snap.entities.map((e) => ({
      entityId: e.entityId,
      name: e.name,
      regime: e.regime,
      vatStatus: e.vatStatus,
      applicable: e.applicable,
      rate: e.rate,
      revenue: d(e.revenue),
      tax: d(e.tax),
      kind: e.kind,
      revenueStep: e.revenueStep,
      taxStep: e.taxStep,
      months: e.months.map((m) => ({
        year: m.year,
        month: m.month,
        key: m.key,
        label: m.label,
        status: m.status,
        coverage: dec(m.coverage),
        basis: m.basis,
        revenue: d(m.revenue),
        tax: d(m.tax),
        exempt: m.exempt,
        sourceId: m.sourceId,
        updatedAt: m.updatedAt,
        revenueStep: m.revenueStep,
        taxStep: m.taxStep,
      })),
    })),
    months: snap.months.map((m) => ({
      key: m.key,
      label: m.label,
      status: m.status,
      coverage: dec(m.coverage),
      revenue: d(m.revenue),
      tax: d(m.tax),
    })),
    steps,
    totalStep: snap.totalStep,
    revenueStep: snap.revenueStep,
    rules: snap.rules,
    source: snap.source,
    asOf: snap.asOf,
    kind: snap.kind,
    warnings: snap.warnings,
    assumptions: snap.assumptions ?? [],
    scenario: snap.scenario ?? null,
    whatIf: snap.whatIf ?? null,
  };
}

import { dec } from './decimal';
import type { CalcCtx, DashboardInput, EntityInput, RuleSet, Selections, TaxRegime } from './types';

/** Вид входа калькулятора для передачи по сети: деньги строками, чтобы не терять точность. */
export interface DashboardPayload {
  /** Время сервера, мс. Клиент считает смещение своих часов и тикает по серверному времени */
  serverNow: number;
  tz: string;
  weights: string[];
  rules: {
    asOf: string;
    year: number;
    vatExemptLimit: string;
    limit5: string | null;
    limit7: string | null;
    rates: number[];
    generalRate: number;
    twelveQuarters: number;
    rateWindowMonths: number[];
    nextYear: { year: number; deflatorKnown: boolean; base5: string | null; base7: string | null };
    groupSigns: string | null;
    profitTaxRate: string;
    usnRateIncome: string;
    usnRateIncomeExpense: string;
    usnMinTaxRate: string;
    paymentDay: number;
  };
  entities: {
    id: string;
    name: string;
    form: string;
    ownerLabel: string;
    status: 'payer' | 'exempt';
    annualRevenue: string;
    inputVatShare: string;
    color: string;
    description: string;
    taxRegime: TaxRegime;
    usnRate: string | null;
    annualExpenses: string;
    monthly: { month: number; amount: string; isFact: boolean }[];
  }[];
  selections: Selections;
}

export function toPayload(input: DashboardInput, meta: { serverNow: number; tz: string }): DashboardPayload {
  const r = input.ctx.rules;
  return {
    serverNow: meta.serverNow,
    tz: meta.tz,
    weights: input.ctx.weights.map((w) => w.toString()),
    rules: {
      asOf: r.asOf,
      year: r.year,
      vatExemptLimit: r.vatExemptLimit.toString(),
      limit5: r.limit5?.toString() ?? null,
      limit7: r.limit7?.toString() ?? null,
      rates: r.rates,
      generalRate: r.generalRate,
      twelveQuarters: r.twelveQuarters,
      rateWindowMonths: r.rateWindowMonths,
      nextYear: {
        year: r.nextYear.year,
        deflatorKnown: r.nextYear.deflatorKnown,
        base5: r.nextYear.base5?.toString() ?? null,
        base7: r.nextYear.base7?.toString() ?? null,
      },
      groupSigns: r.groupSigns,
      profitTaxRate: r.profitTaxRate.toString(),
      usnRateIncome: r.usnRateIncome.toString(),
      usnRateIncomeExpense: r.usnRateIncomeExpense.toString(),
      usnMinTaxRate: r.usnMinTaxRate.toString(),
      paymentDay: r.paymentDay,
    },
    entities: input.entities.map((e) => ({
      id: e.id,
      name: e.name,
      form: e.form,
      ownerLabel: e.ownerLabel,
      status: e.status,
      annualRevenue: e.annualRevenue.toString(),
      inputVatShare: e.inputVatShare.toString(),
      color: e.color,
      description: e.description,
      taxRegime: e.taxRegime,
      usnRate: e.usnRate?.toString() ?? null,
      annualExpenses: e.annualExpenses.toString(),
      monthly: (e.monthly ?? []).map((m) => ({ month: m.month, amount: m.amount.toString(), isFact: m.isFact })),
    })),
    selections: input.selections,
  };
}

export function fromPayload(p: DashboardPayload): DashboardInput {
  const rules: RuleSet = {
    asOf: p.rules.asOf,
    year: p.rules.year,
    vatExemptLimit: dec(p.rules.vatExemptLimit),
    limit5: p.rules.limit5 === null ? null : dec(p.rules.limit5),
    limit7: p.rules.limit7 === null ? null : dec(p.rules.limit7),
    rates: p.rules.rates as RuleSet['rates'],
    generalRate: p.rules.generalRate,
    twelveQuarters: p.rules.twelveQuarters,
    rateWindowMonths: p.rules.rateWindowMonths,
    nextYear: {
      year: p.rules.nextYear.year,
      deflatorKnown: p.rules.nextYear.deflatorKnown,
      base5: p.rules.nextYear.base5 === null ? null : dec(p.rules.nextYear.base5),
      base7: p.rules.nextYear.base7 === null ? null : dec(p.rules.nextYear.base7),
    },
    groupSigns: p.rules.groupSigns,
    profitTaxRate: dec(p.rules.profitTaxRate),
    usnRateIncome: dec(p.rules.usnRateIncome),
    usnRateIncomeExpense: dec(p.rules.usnRateIncomeExpense),
    usnMinTaxRate: dec(p.rules.usnMinTaxRate),
    paymentDay: p.rules.paymentDay,
  };
  const ctx: CalcCtx = { weights: p.weights.map((w) => dec(w)), rules };
  const entities: EntityInput[] = p.entities.map((e) => ({
    id: e.id,
    name: e.name,
    form: e.form,
    ownerLabel: e.ownerLabel,
    status: e.status,
    annualRevenue: dec(e.annualRevenue),
    inputVatShare: dec(e.inputVatShare),
    color: e.color,
    description: e.description,
    taxRegime: e.taxRegime,
    usnRate: e.usnRate === null ? null : dec(e.usnRate),
    annualExpenses: dec(e.annualExpenses),
    monthly: e.monthly.map((m) => ({ month: m.month, amount: dec(m.amount), isFact: m.isFact })),
  }));
  return { entities, selections: p.selections, ctx };
}

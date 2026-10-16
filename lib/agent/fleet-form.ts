import {
  FLEET_DEFAULT_RENT_DAYS,
  FLEET_QUICK_COST,
  FLEET_QUICK_RENT,
  MONTHS_GENITIVE,
  MONTH_NAMES,
  fleetRevenuePerCar,
  pluralRu,
  rub,
  type CarsRequest,
  type Moment,
} from '@/lib/calc';
import { shortName } from './entities';
import type {
  EntityRef,
  FleetForm,
  FleetFormField,
  FleetFormSubmit,
  FleetFormValues,
} from './types';

/**
 * Карточка «Что если купим N машин»: поля, которые агент подставляет из вопроса, если человек их
 * назвал, и спрашивает, если нет. Здесь только сборка карточки и запроса из полей; числа считает
 * расчётное ядро (lib/calc/whatif.ts), карточка ничего не считает и ничего не подставляет молча,
 * кроме двух значений по умолчанию, которые видны в самих полях: 20 дней сдачи и следующий месяц.
 */

/** Месяцы начала сдачи: следующий за идущим и до декабря. */
export function monthOptions(today: Moment): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = [];
  for (let m = today.month + 1; m <= 11; m++) {
    const name = MONTH_NAMES[m]!;
    out.push({ value: m, label: name.charAt(0).toUpperCase() + name.slice(1) });
  }
  return out;
}

export interface FleetDraft {
  values: FleetFormValues;
  missing: FleetFormField[];
  confirmVat: boolean;
  /** Месяц начала назван в вопросе, но уже идёт или прошёл: в поле стоит ближайший, человек проверяет */
  badStart: boolean;
}

/**
 * Что понято из вопроса. Названное подставляется, ненайденное остаётся пустым и попадает в
 * `missing`; 20 дней и следующий месяц берутся по умолчанию и стоят в полях видимыми значениями.
 * Если стоимость названа, а «с НДС» или «без НДС» нет, переключатель просит подтвердить.
 */
export function fleetDraft(req: CarsRequest, entityIds: string[], today: Moment): FleetDraft {
  const f = req.fleet ?? {};
  const nextMonth = Math.min(today.month + 1, 11);
  const startOk = f.startMonth !== undefined && f.startMonth > today.month && f.startMonth <= 11;
  const values: FleetFormValues = {
    entityId: entityIds.length === 1 ? entityIds[0]! : null,
    cars: req.cars ?? null,
    cost: f.cost ?? null,
    costWithVat: f.costWithVat ?? true,
    rentPerDay: f.rentPerDay ?? null,
    rentDays: f.rentDays ?? FLEET_DEFAULT_RENT_DAYS,
    startMonth: startOk ? f.startMonth! : nextMonth,
    expenses: f.expensesPerMonth !== undefined && f.expensesPerMonth > 0 ? f.expensesPerMonth : null,
  };
  const missing: FleetFormField[] = [];
  if (values.entityId === null) missing.push('entity');
  if (values.cars === null) missing.push('cars');
  if (values.cost === null) missing.push('cost');
  if (values.rentPerDay === null) missing.push('rent');
  return {
    values,
    missing,
    confirmVat: f.cost !== undefined && f.costWithVat === undefined,
    badStart: f.startMonth !== undefined && !startOk,
  };
}

export function buildFleetForm(args: {
  mode: FleetForm['mode'];
  draft: FleetDraft;
  entities: EntityRef[];
  today: Moment;
  note?: string | null;
}): FleetForm {
  return {
    mode: args.mode,
    values: args.draft.values,
    missing: args.draft.missing,
    confirmVat: args.draft.confirmVat,
    entities: args.entities.map((e) => ({ id: e.id, label: shortName(e) })),
    months: monthOptions(args.today),
    quick: { cost: [...FLEET_QUICK_COST], rent: [...FLEET_QUICK_RENT] },
    note: args.note ?? null,
  };
}

/** Заполненные поля в запрос ядру. */
export function requestFromSubmit(s: FleetFormSubmit): CarsRequest {
  return {
    kind: 'cars',
    cars: s.cars,
    fleet: {
      cost: s.cost,
      costWithVat: s.costWithVat,
      rentPerDay: s.rentPerDay,
      rentDays: s.rentDays,
      startMonth: s.startMonth,
      expensesPerMonth: s.expenses ?? 0,
    },
  };
}

/** Заполненный запрос обратно в значения полей: для правки под ответом. */
export function valuesFromRequest(req: CarsRequest, entityId: string): FleetFormValues {
  const f = req.fleet!;
  return {
    entityId,
    cars: req.cars,
    cost: f.cost ?? null,
    costWithVat: f.costWithVat ?? true,
    rentPerDay: f.rentPerDay ?? null,
    rentDays: f.rentDays ?? FLEET_DEFAULT_RENT_DAYS,
    startMonth: f.startMonth ?? 0,
    expenses: f.expensesPerMonth && f.expensesPerMonth > 0 ? f.expensesPerMonth : null,
  };
}

/** Сообщение пользователя в ленте при отправке карточки: что именно посчитать. */
export function fleetSubmitText(s: FleetFormSubmit, entities: EntityRef[]): string {
  const name = entities.find((e) => e.id === s.entityId)?.name ?? s.entityId;
  const days = `${s.rentDays} ${pluralRu(s.rentDays, 'день', 'дня', 'дней')}`;
  return (
    `Посчитать: ${name}, ${s.cars} ${pluralRu(s.cars, 'машина', 'машины', 'машин')} по ${rub(s.cost)} ` +
    `${s.costWithVat ? 'с НДС' : 'без НДС'}, сдача ${rub(s.rentPerDay)} в сутки × ${days} = ` +
    `${rub(fleetRevenuePerCar(s.rentPerDay, s.rentDays))} в месяц на машину, с ${MONTHS_GENITIVE[s.startMonth]}` +
    (s.expenses ? `, расходы ${rub(s.expenses)} в месяц на машину` : '')
  );
}

/** Что сказать над недостающими полями. */
export function askText(missing: FleetFormField[], confirmVat: boolean): string {
  const names: Record<FleetFormField, string> = {
    entity: 'юрлицо',
    cars: 'сколько машин',
    cost: 'стоимость машины',
    rent: 'цена сдачи',
  };
  if (missing.length > 0) {
    return `Чтобы посчитать, уточните параметры машин. Не хватает: ${missing.map((m) => names[m]).join(', ')}.`;
  }
  if (confirmVat) return 'Проверьте стоимость машины: она с НДС или без НДС? От этого зависит вычет входного НДС.';
  return 'Проверьте параметры машин и нажмите «Рассчитать».';
}

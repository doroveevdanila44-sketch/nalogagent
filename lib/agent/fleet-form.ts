import {
  FLEET_DEFAULT_RENT_DAYS,
  FLEET_MAX_DIFFERENT,
  FLEET_QUICK_COST,
  FLEET_QUICK_RENT,
  MONTHS_GENITIVE,
  MONTH_NAMES,
  fleetIsUniform,
  fleetRevenuePerCar,
  fleetUnitPrices,
  pluralRu,
  rub,
  type CarsRequest,
  type Moment,
} from '@/lib/calc';
import { shortName } from './entities';
import type {
  QuickReply,
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
 * `missing`; 20 дней, «с НДС» (покупка у дилера) и следующий месяц берутся по умолчанию и стоят в полях
 * видимыми значениями. Цены названы по машинам («первая 3 млн, вторая 5 млн»): переключатель «Все
 * машины одинаковые» выключен, у каждой машины своя строка (до 10 машин).
 */
export function fleetDraft(req: CarsRequest, entityIds: string[], today: Moment): FleetDraft {
  const f = req.fleet ?? {};
  const nextMonth = Math.min(today.month + 1, 11);
  const startOk = f.startMonth !== undefined && f.startMonth > today.month && f.startMonth <= 11;
  const prices = fleetUnitPrices(req);
  // «Да, для остальных такая же»: цены сошлись в одну, форма показывает режим «все одинаковые»
  const merged = f.rest === 'same' && req.cars !== null && prices.length > 0 && prices.every((p) => p.cost !== null) && fleetIsUniform(prices);
  const different =
    !merged && ((f.units?.length ?? 0) > 0 || f.rest === 'each') && (req.cars === null || req.cars <= FLEET_MAX_DIFFERENT);
  const values: FleetFormValues = {
    entityId: entityIds.length === 1 ? entityIds[0]! : null,
    cars: req.cars ?? null,
    same: !different,
    cost: f.cost ?? (merged ? prices[0]!.cost : null),
    costWithVat: f.costWithVat ?? true,
    rentPerDay: f.rentPerDay ?? (merged ? prices[0]!.rentPerDay : null),
    units: different
      ? (prices.length > 0 ? prices : (f.units ?? []).map((u) => ({ cost: u?.cost ?? null, rentPerDay: u?.rentPerDay ?? f.rentPerDay ?? null }))).map((p) => ({
          cost: p.cost,
          rentPerDay: p.rentPerDay,
        }))
      : [],
    rentDays: f.rentDays ?? FLEET_DEFAULT_RENT_DAYS,
    startMonth: startOk ? f.startMonth! : nextMonth,
    expenses: f.expensesPerMonth !== undefined && f.expensesPerMonth > 0 ? f.expensesPerMonth : null,
  };
  const missing: FleetFormField[] = [];
  if (values.entityId === null) missing.push('entity');
  if (values.cars === null) missing.push('cars');
  if (req.cars === null) {
    if (f.cost === undefined && !(f.units ?? []).some((u) => u?.cost !== undefined)) missing.push('cost');
    if (f.rentPerDay === undefined && !(f.units ?? []).some((u) => u?.rentPerDay !== undefined)) missing.push('rent');
  } else {
    if (prices.some((p) => p.cost === null)) missing.push('cost');
    if (prices.some((p) => p.rentPerDay === null)) missing.push('rent');
  }
  return {
    values,
    missing,
    // «с НДС» по умолчанию, подтверждать не нужно: значение видно в карточке и в первой строке ответа
    confirmVat: false,
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
      costWithVat: s.costWithVat,
      rentDays: s.rentDays,
      startMonth: s.startMonth,
      expensesPerMonth: s.expenses ?? 0,
      ...(s.units ? { units: s.units } : { cost: s.cost ?? undefined, rentPerDay: s.rentPerDay ?? undefined }),
    },
  };
}

/** Заполненный запрос обратно в значения полей: для правки под ответом. */
export function valuesFromRequest(req: CarsRequest, entityId: string): FleetFormValues {
  const f = req.fleet!;
  const prices = fleetUnitPrices(req);
  const different = (f.units?.length ?? 0) > 0 && (req.cars ?? 0) <= FLEET_MAX_DIFFERENT;
  return {
    entityId,
    cars: req.cars,
    same: !different,
    cost: f.cost ?? (different ? null : (prices[0]?.cost ?? null)),
    costWithVat: f.costWithVat ?? true,
    rentPerDay: f.rentPerDay ?? (different ? null : (prices[0]?.rentPerDay ?? null)),
    units: different ? prices.map((p) => ({ cost: p.cost, rentPerDay: p.rentPerDay })) : [],
    rentDays: f.rentDays ?? FLEET_DEFAULT_RENT_DAYS,
    startMonth: f.startMonth ?? 0,
    expenses: f.expensesPerMonth && f.expensesPerMonth > 0 ? f.expensesPerMonth : null,
  };
}

/** Сообщение пользователя в ленте при отправке карточки: что именно посчитать. */
export function fleetSubmitText(s: FleetFormSubmit, entities: EntityRef[]): string {
  const name = entities.find((e) => e.id === s.entityId)?.name ?? s.entityId;
  const days = `${s.rentDays} ${pluralRu(s.rentDays, 'день', 'дня', 'дней')}`;
  const cars = `${s.cars} ${pluralRu(s.cars, 'машина', 'машины', 'машин')}`;
  const vat = s.costWithVat ? 'с НДС' : 'без НДС';
  const tail = `с ${MONTHS_GENITIVE[s.startMonth]}` + (s.expenses ? `, расходы ${rub(s.expenses)} в месяц на машину` : '');
  if (s.units) {
    const list = s.units
      .map((u, i) => `машина ${i + 1} за ${rub(u.cost)} (сдача ${rub(u.rentPerDay)} в сутки)`)
      .join(', ');
    return `Посчитать: ${name}, ${cars} ${vat}: ${list}, × ${days} в месяц, ${tail}`;
  }
  return (
    `Посчитать: ${name}, ${cars} по ${rub(s.cost ?? 0)} ${vat}, сдача ${rub(s.rentPerDay ?? 0)} в сутки × ${days} = ` +
    `${rub(fleetRevenuePerCar(s.rentPerDay ?? 0, s.rentDays))} в месяц на машину, ${tail}`
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

const GENITIVE: Record<number, string> = { 2: 'двух', 3: 'трёх', 4: 'четырёх', 5: 'пяти', 6: 'шести', 7: 'семи', 8: 'восьми', 9: 'девяти', 10: 'десяти' };

/** Текст кнопок «Да» и «Указать каждую»: по ним интерпретация узнаёт ответ (fleet-extract.ts, restReply). */
export const REST_SAME_TEXT = 'да, для остальных такая же цена';
export const REST_EACH_TEXT = 'указать цену каждой машины';

/**
 * Названы цены не всех машин («5 машин, первая 3 млн»): агент спрашивает «Для остальных четырёх такая
 * же цена?» с кнопками «Да» и «Указать каждую». Больше 10 машин разные цены недоступны, остаётся «Да».
 * null, если спрашивать нечего: цены названы всем, есть общая цена или решение уже принято.
 */
export function restQuestion(req: CarsRequest): { text: string; quick: QuickReply[] } | null {
  const f = req.fleet ?? {};
  const n = req.cars;
  if (n === null || n < 2 || f.rest !== undefined || f.cost !== undefined) return null;
  const named = (f.units ?? []).map((u, i) => (u?.cost !== undefined ? i : -1)).filter((i) => i >= 0);
  if (named.length === 0 || named.length >= n) return null;
  const left = n - named.length;
  const who = left === 1 ? 'остальной машины' : `остальных ${GENITIVE[left] ?? `${left} машин`}`;
  const last = named[named.length - 1]! + 1;
  const text = `Для ${who} такая же цена${named.length > 1 ? `, как у машины ${last}` : ''}?`;
  const quick: QuickReply[] = [{ label: 'Да', text: REST_SAME_TEXT }];
  if (n <= FLEET_MAX_DIFFERENT) quick.push({ label: 'Указать каждую', text: REST_EACH_TEXT });
  return { text, quick };
}

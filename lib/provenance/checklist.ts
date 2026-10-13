import { dec } from '@/lib/calc/decimal';
import { rub2 } from '@/lib/calc/format';
import { moneyText } from '@/lib/calc/provenance';
import { lineFromSnapshots, preciseDateTime, snapshotTitle, type SourceLineData } from './line';
import { normLink, RULE_TITLE, type NormLink } from './norms';
import type { CalcSnapshot, SnapshotStep } from './snapshot';

/**
 * Чек-лист «Проверить самому»: всё, что нужно, чтобы пересчитать цифру без приложения. Модель
 * собирается из снимка CalcResult: исходные цифры по месяцам, формулы словами, правила с нормой,
 * шаги расчёта по юрлицам и итог. Новых чисел здесь нет, только раскладка того, что посчитано.
 */

export interface CheckStep {
  id: string;
  label: string;
  /** Формула с подставленными числами, как её видит человек */
  text: string;
  /** Выражение для пересчёта: s1 * 5 / 105 */
  formula: string;
  result: string;
}

export interface CheckMonth {
  label: string;
  basis: string;
  revenue: string;
  tax: string;
}

export interface CheckEntity {
  entityId: string;
  name: string;
  revenue: string | null;
  tax: string | null;
  months: CheckMonth[];
  steps: CheckStep[];
}

export interface CheckRule {
  key: string;
  title: string;
  value: string;
  from: string;
  to: string | null;
  norm: NormLink | null;
  note: string | null;
}

export interface CheckItem {
  /** Ключ отметки внутри расчёта: src, rules, ent:alfa, total */
  id: string;
  title: string;
  hint: string;
}

export interface CheckSection {
  /** Номер расчёта в наборе */
  index: number;
  title: string;
  total: string | null;
  line: SourceLineData;
  words: string[];
  entities: CheckEntity[];
  rules: CheckRule[];
  items: CheckItem[];
  /** Итог одним текстом для отметки «сверил» */
  amount: string | null;
}

const BASIS: Record<string, string> = { fact: 'факт', forecast: 'прогноз' };

function ruleValue(r: CalcSnapshot['rules'][number]): string {
  if (r.value !== null) {
    const n = r.value.replace(/\.0+$/, '');
    if (r.unit === 'percent') return `${n}%`;
    if (r.unit === 'rub') return moneyText(dec(r.value));
    return n;
  }
  return r.formula ?? 'не утверждено';
}

/** Формулы словами для налога расчёта. Числа ставок берутся из применённых правил и юрлиц. */
function wordsFor(s: CalcSnapshot): string[] {
  const out: string[] = [];
  const rate = (key: string) => s.rules.find((r) => r.key === key);
  if (s.tax === 'vat') {
    const rates = [...new Set(s.entities.filter((e) => e.applicable && e.rate !== null).map((e) => e.rate!))];
    const general = rate('rate_general');
    const special = rates.filter((r) => r !== (general ? Number(general.value) : 22));
    if (special.length > 0) {
      out.push(
        `НДС по ставке ${special.join('% или ')}%: выручка с НДС за месяц × ставка / (100 + ставка). Вычеты по такой ставке не применяются.`,
      );
    }
    if (rates.some((r) => !special.includes(r))) {
      out.push(
        'НДС по общей ставке: выручка с НДС за месяц × ставка / (100 + ставка) × (1 − доля закупок с входным НДС). Доля закупок задана у юрлица в справочнике.',
      );
    }
    const limit = rate('vat_exempt_limit');
    if (s.entities.some((e) => e.months.some((m) => m.exempt))) {
      out.push(
        `Освобождённое юрлицо не платит НДС, пока выручка года не достигнет порога${limit ? ` ${ruleValue(limit)}` : ''}; налог начинается со следующего месяца после пересечения.`,
      );
    }
    out.push('Налог юрлица за период: сумма налогов по месяцам, округлённая до копеек один раз.');
    out.push('Итог по группе: сумма итогов юрлиц, каждый уже округлён до копеек.');
  } else {
    const income = s.tax === 'usn' ? 'доходы' : 'выручка';
    out.push(
      `Доходы без НДС: прогноз выручки года с НДС минус НДС, заложенный в облагаемую часть выручки (${income} без НДС).`,
    );
    if (s.tax === 'usn') {
      out.push(
        'УСН «доходы»: доходы без НДС × ставка. УСН «доходы минус расходы»: (доходы без НДС − расходы, не меньше нуля) × ставка, но не меньше минимального налога от доходов.',
      );
    } else {
      out.push('Налог на прибыль: (выручка без НДС − расходы, не меньше нуля) × ставка.');
    }
    out.push('Налог периода: налог года × выручка периода / выручка года. Итог юрлица округляется до копеек один раз.');
    out.push('Итог по группе: сумма итогов юрлиц.');
  }
  return out;
}

function stepsOf(s: CalcSnapshot, entityId: string): CheckStep[] {
  return s.steps
    .filter((st: SnapshotStep) => st.entityId === entityId)
    .map((st) => ({
      id: st.id,
      label: st.label,
      text: st.text,
      formula: st.expression,
      result: rub2(dec(st.result)),
    }));
}

export function buildChecklist(snaps: CalcSnapshot[]): CheckSection[] {
  return snaps.map((s, index) => {
    const entities: CheckEntity[] = s.entities
      .filter((e) => e.applicable)
      .map((e) => ({
        entityId: e.entityId,
        name: e.name,
        revenue: e.revenue === null ? null : rub2(dec(e.revenue)),
        tax: e.tax === null ? null : rub2(dec(e.tax)),
        months: e.months.map((m) => ({
          label: m.label,
          basis: m.exempt ? 'освобождено' : m.status === 'partial' ? 'идёт' : (BASIS[m.basis ?? ''] ?? 'нет данных'),
          revenue: m.revenue === null ? 'нет данных' : rub2(dec(m.revenue)),
          tax: m.tax === null ? 'нет данных' : rub2(dec(m.tax)),
        })),
        steps: stepsOf(s, e.entityId),
      }));

    const rules: CheckRule[] = s.rules.map((r) => ({
      key: r.key,
      title: RULE_TITLE[r.key] ?? r.key,
      value: ruleValue(r),
      from: r.validFrom,
      to: r.validTo,
      norm: normLink(r.norm, r.sourceUrl),
      note: r.note,
    }));

    const items: CheckItem[] = [
      {
        id: 'src',
        title: 'Исходные цифры',
        hint: 'Выручка по месяцам совпадает с выгрузкой из источника',
      },
      {
        id: 'rules',
        title: 'Ставка и норма',
        hint: 'Ставки и пороги совпадают с нормой НК РФ на дату расчёта',
      },
      ...entities.map((e) => ({
        id: `ent:${e.entityId}`,
        title: `Расчёт: ${e.name}`,
        hint: 'Пересчитайте шаги формулы по юрлицу и сверьте итог',
      })),
      {
        id: 'total',
        title: 'Итог',
        hint: entities.length > 1 ? 'Сумма итогов юрлиц равна итогу расчёта' : 'Итог юрлица равен итогу расчёта',
      },
    ];

    return {
      index,
      title: snapshotTitle(s),
      total: s.total === null ? null : rub2(dec(s.total)),
      line: lineFromSnapshots([s]),
      words: wordsFor(s),
      entities,
      rules,
      items,
      amount: s.total,
    };
  });
}

/**
 * Текст для «Скопировать формулы»: по строке на шаг, номер шага, выражение и результат. Выражения
 * можно вставить в таблицу и пересчитать, ссылки sN указывают на строки с этими номерами.
 */
export function formulasText(snaps: CalcSnapshot[]): string {
  const lines: string[] = [];
  snaps.forEach((s, i) => {
    const head = `${i > 0 ? '\n' : ''}${snapshotTitle(s)}`;
    lines.push(head);
    lines.push(`Расчёт на ${preciseDateTime(s.at, s.tz)}.`);
    lines.push('Шаг\tЮрлицо\tФормула\tРезультат, ₽\tКак считается');
    const names = new Map(s.entities.map((e) => [e.entityId, e.name]));
    for (const st of s.steps) {
      lines.push(
        [
          st.id,
          st.entityId ? (names.get(st.entityId) ?? '') : 'Группа',
          st.expression,
          dec(st.result).toFixed(2),
          st.text,
        ].join('\t'),
      );
    }
    if (s.total !== null) lines.push(`Итог\t\t\t${dec(s.total).toFixed(2)}\t${s.taxName}: ${rub2(dec(s.total))}`);
  });
  lines.push('');
  lines.push('round2(x) это ROUND(x; 2), max и min это МАКС и МИН. Ссылки sN указывают на результат шага sN.');
  return lines.join('\n');
}

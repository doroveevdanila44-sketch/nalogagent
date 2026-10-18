import {
  REGIME_LABEL,
  dateRu,
  mln,
  pct,
  rub,
  rub2,
  signedMln,
  type EntityInput,
  type RuleSet,
} from '@/lib/calc';
import type { LiveModel, StaticModel } from '@/lib/calc';
import { entityColor } from '@/lib/theme';
import { CalcActions } from '@/components/provenance/CalcActions';
import { SourceLine } from '@/components/provenance/SourceLine';
import { sourceLineText } from '@/lib/provenance/line';
import { entityQueries, type EntityLines } from '@/lib/provenance/dashboard';

interface Props {
  entity: EntityInput;
  rules: RuleSet;
  live: LiveModel['perEntity'][string];
  stat: StaticModel['perEntity'][string];
  /** Строки происхождения под блоками карточки (из результатов calcTax) */
  lines: EntityLines;
  year: number;
  /** Момент (мс UTC), на который показаны цифры */
  getAt: () => number;
}

/** Описание базы налога одной строкой, из цифр калькулятора. */
function baseNote(e: EntityInput, t: StaticModel['perEntity'][string]['incomeTax']): string {
  switch (e.taxRegime) {
    case 'usn_income':
      return `Прогноз года: доходы без НДС ${mln(t.income, 2)} × ${t.ratePct.toString()}%`;
    case 'usn_income_expense':
      return (
        `Доходы без НДС ${mln(t.income, 2)} минус расходы ${mln(t.expenses, 2)} = ${mln(t.base, 2)}. ` +
        `Минимальный налог 1% доходов: ${mln(t.minimum, 2)}${t.minTaxApplied ? ', применён' : ''}`
      );
    case 'osno':
      return `Выручка без НДС ${mln(t.income, 2)} минус расходы ${mln(t.expenses, 2)} = прибыль ${mln(t.base, 2)}`;
  }
}

export function EntityCard({ entity: e, rules, live, stat, lines, year, getAt }: Props) {
  const payer = e.status === 'payer';
  const osno = e.taxRegime === 'osno';
  const limit = payer ? rules.limit5 : rules.vatExemptLimit;
  const used = limit && !limit.isZero() ? Math.min(100, live.ytd.div(limit).times(100).toNumber()) : 0;
  const usageLabel = payer
    ? `Лимит ставки 5%: ${limit ? mln(limit, 1) : 'не утверждён'}`
    : `Порог освобождения: ${mln(rules.vatExemptLimit, 0)}`;
  const usagePct = limit ? pct(live.ytd.div(limit), payer ? 1 : 0) : '';
  const selectedValue = payer ? stat.forecast[stat.selected]! : stat.fullYear[stat.selected]!;
  const tax = stat.incomeTax;
  const next = tax.next;
  // строка происхождения под блоком только если она отличается от строки предыдущего блока карточки
  const metricsText = sourceLineText(lines.metrics);
  const vatText = sourceLineText(lines.vat);
  const showVatLine = vatText !== metricsText;
  const showIncomeLine = sourceLineText(lines.income) !== (showVatLine ? vatText : metricsText);

  return (
    <article className="ent" data-tour="entity">
      {/* Для обучения: статус юрлица и полоса порога подсвечиваются одним блоком */}
      <div data-tour={payer || osno ? undefined : 'entity-threshold'}>
        <div className="ent-h">
          <div>
            <h3>
              <i style={{ background: entityColor(e) }} />
              {e.name}
            </h3>
            <p className="ent-d">
              {e.description} · {e.ownerLabel}
            </p>
          </div>
          <div className="chips">
            <span className="chip">{e.form}</span>
            <span className={`chip ${payer ? 'pay' : 'ex'}`}>{payer ? 'Плательщик НДС' : 'Освобождён'}</span>
            <span className="chip regime">
              {REGIME_LABEL[e.taxRegime]}, {tax.ratePct.toString()}%
            </span>
          </div>
        </div>

        <div className="ent-m">
          <div>
            <span className="eyebrow">Выручка с начала года</span>
            <b>{rub(live.ytd)}</b>
          </div>
          <div>
            <span className="eyebrow">Прогноз года</span>
            <b>{mln(e.annualRevenue, 1)}</b>
          </div>
        </div>
        <SourceLine data={lines.metrics} />

        {osno ? null : (
          <>
            <div className="bar" role="img" aria-label={`Использование порога: ${usagePct}`}>
              <i style={{ width: `${used.toFixed(2)}%` }} />
            </div>
            <div className="bar-l">
              <span>{usageLabel}</span>
              <span>{usagePct}</span>
            </div>
          </>
        )}
      </div>

      {payer ? null : (
        <p className="hint">
          Сейчас НДС не платится. Суммы ниже показывают налог, если юрлицо потеряет освобождение.
        </p>
      )}

      {osno ? (
        <div className="rates single" role="group" aria-label={`НДС для ${e.name}`}>
          <div className="rate sel">
            <span className="rate-top">
              <span className="rate-n">НДС 22%</span>
              <span className="tag">С вычетами</span>
            </span>
            <span className="rate-sum">{rub2(live.accrued[22]!)}</span>
            <span className="rate-sub">налог с начала года, ставка одна, вычеты разрешены</span>
            <span className="rate-row">
              <span>Прогноз года</span>
              <b>{mln(stat.forecast[22]!, 2)}</b>
            </span>
          </div>
        </div>
      ) : (
        <div className="rates" role="group" aria-label={`Ставка НДС для ${e.name}`} data-tour="rates">
          {rules.rates.map((r) => {
            const isSel = stat.selected === r;
            const value = payer ? stat.forecast[r]! : stat.fullYear[r]!;
            const delta = value.minus(selectedValue);
            return (
              <div key={r} className={`rate ${isSel ? 'sel' : 'alt'}`}>
                <span className="rate-top">
                  <span className="rate-n">{r}%</span>
                  <span className="tag">{isSel ? 'Выбрана' : 'Сравнение'}</span>
                </span>
                <span className="rate-sum">{rub2(live.accrued[r]!)}</span>
                <span className="rate-sub">{payer ? 'налог с начала года' : 'условно, если порог пройден'}</span>
                <span className="rate-row">
                  <span>{payer ? 'Прогноз года' : 'За весь год'}</span>
                  <b>{mln(value, 2)}</b>
                </span>
                {isSel ? null : (
                  <span className="rate-row">
                    <span>К выбранной</span>
                    <b>{signedMln(delta, 2)}</b>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showVatLine ? <SourceLine data={lines.vat} /> : null}

      <section className="taxblock" aria-label={`${tax.taxName}, прогноз`}>
        <h4>{tax.taxName}, прогноз</h4>
        <dl>
          <div>
            <dt>Начислено</dt>
            <dd>{rub2(live.incomeTaxAccrued)}</dd>
          </div>
          <div>
            <dt>Прогноз за год</dt>
            <dd>{mln(tax.forecast, 2)}</dd>
          </div>
          <div className="wide">
            <dt>Ближайший платёж</dt>
            <dd>
              {next ? (
                <>
                  {dateRu(next.due)}
                  {next.due.year !== year ? ` ${next.due.year}` : ''}, {rub(next.amount)}{' '}
                  <span className="muted">({next.kind === 'final' ? 'итог за год' : `аванс ${next.periodLabel}`})</span>
                </>
              ) : (
                'сроки на этот год прошли'
              )}
            </dd>
          </div>
        </dl>
        <p className="taxblock-note">{baseNote(e, tax)}.</p>
      </section>
      {showIncomeLine ? <SourceLine data={lines.income} /> : null}

      <CalcActions
        label={`Действия с расчётом: ${e.name}`}
        getTarget={() => ({
          queries: entityQueries({ id: e.id, taxRegime: e.taxRegime, selected: stat.selected }, year),
          at: getAt(),
        })}
      />
    </article>
  );
}

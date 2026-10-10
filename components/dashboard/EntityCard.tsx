import {
  mln,
  pct,
  rub,
  rub2,
  signedMln,
  type EntityInput,
  type RuleSet,
} from '@/lib/calc';
import type { LiveModel, StaticModel } from '@/lib/calc';

interface Props {
  entity: EntityInput;
  rules: RuleSet;
  live: LiveModel['perEntity'][string];
  stat: StaticModel['perEntity'][string];
  onChoose: (rate: number) => void;
}

export function EntityCard({ entity: e, rules, live, stat, onChoose }: Props) {
  const payer = e.status === 'payer';
  const limit = payer ? rules.limit5 : rules.vatExemptLimit;
  const used = limit && !limit.isZero() ? Math.min(100, live.ytd.div(limit).times(100).toNumber()) : 0;
  const usageLabel = payer ? `Лимит ставки 5%: ${limit ? mln(limit, 1) : 'не утверждён'}` : `Порог освобождения: ${mln(rules.vatExemptLimit, 0)}`;
  const usagePct = limit ? pct(live.ytd.div(limit), payer ? 1 : 0) : '';
  const selectedValue = payer ? stat.forecast[stat.selected]! : stat.fullYear[stat.selected]!;

  return (
    <article className="ent">
      <div className="ent-h">
        <div>
          <h3>
            <i style={{ background: e.color }} />
            {e.name}
          </h3>
          <p className="ent-d">
            {e.description} · {e.ownerLabel}
          </p>
        </div>
        <div className="chips">
          <span className="chip">{e.form}</span>
          <span className={`chip ${payer ? 'pay' : 'ex'}`}>{payer ? 'Плательщик НДС' : 'Освобождён'}</span>
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

      <div className="bar" role="img" aria-label={`Использование порога: ${usagePct}`}>
        <i style={{ width: `${used.toFixed(2)}%` }} />
      </div>
      <div className="bar-l">
        <span>{usageLabel}</span>
        <span>{usagePct}</span>
      </div>

      {payer ? null : (
        <p className="hint">
          Сейчас НДС не платится. Суммы ниже показывают налог, если юрлицо потеряет освобождение.
        </p>
      )}

      <div className="rates" role="group" aria-label={`Ставка НДС для ${e.name}`}>
        {rules.rates.map((r) => {
          const isSel = stat.selected === r;
          const value = payer ? stat.forecast[r]! : stat.fullYear[r]!;
          const delta = value.minus(selectedValue);
          return (
            <button
              key={r}
              type="button"
              className={`rate ${isSel ? 'sel' : 'alt'}`}
              aria-pressed={isSel}
              onClick={() => onChoose(r)}
            >
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
              <span className="rate-row">
                <span>К выбранной</span>
                <b>{isSel ? 'выбрана' : signedMln(delta, 2)}</b>
              </span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

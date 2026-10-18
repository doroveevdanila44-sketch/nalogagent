'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { FleetForm, FleetFormSubmit } from '@/lib/agent/types';
import {
  FLEET_MAX_DIFFERENT,
  fleetLiveLine,
  fleetSoftWarnings,
  mln,
  rub,
  type FleetUnitPrice,
} from '@/lib/calc';
import { KEYBOARD_EVENT } from '@/lib/client/keyboard';

/**
 * Карточка «Что если купим N машин»: поля, которые агент подставил из вопроса, и пустые, которые
 * он спрашивает. Поля соответствуют числу машин: «Сколько машин» и переключатель «Все машины
 * одинаковые». Включён: одна стоимость, одна цена сдачи на всех. Выключен (до 10 машин): строка на
 * каждую машину со своей стоимостью и ценой сдачи, дни сдачи общие. Пока обязательные поля не
 * заполнены, «Рассчитать» не работает, а над кнопкой названо, чего не хватает («Укажите стоимость
 * машины 2»). Поля ввода числовые (inputmode numeric, пробелы между тысячами), шрифт 16 px, чтобы iOS
 * не увеличивал страницу. Карточка ничего не считает сама: итоговую строку и мягкие предупреждения
 * («стоимость меньше 300 000 ₽, проверьте») даёт расчётное ядро, те же функции, что считают ответ.
 */

const hold = (e: PointerEvent | MouseEvent) => e.preventDefault();

const digits = (s: string): string => s.replace(/\D/g, '');
/** «3000000» → «3 000 000» */
const group = (d: string): string => d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const show = (n: number | null): string => (n === null ? '' : group(String(Math.round(n))));
const toNum = (s: string): number | null => {
  const d = digits(s);
  return d === '' ? null : Number(d);
};

/**
 * Показывает поле, если оно не целиком в видимой части списка (над полем ввода чата, под шапкой):
 * прокручивает список так, чтобы поле стояло по центру. Только свой контейнер чата (scrollTo), не
 * scrollIntoView: тот мог бы сдвинуть окно и увезти шапку под часы. Поле, которое и так видно,
 * не трогается: прокрутка не спорит с пальцем.
 */
function reveal(el: HTMLElement): void {
  const box = el.closest<HTMLElement>('.chat-scroll');
  if (!box) return;
  const c = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const composer = document.querySelector('.composer-wrap')?.getBoundingClientRect();
  let bottom = composer ? Math.min(c.bottom, composer.top) : c.bottom;
  // «Рассчитать» прижата к низу списка (sticky) и закрывает его нижнюю часть: поле должно быть над ней
  const bar = el.closest('[data-form]')?.querySelector('.ff-bar')?.getBoundingClientRect();
  if (bar && bar.top < bottom) bottom = Math.max(c.top, bar.top);
  if (r.top >= c.top + 8 && r.bottom <= bottom - 8) return;
  const top = box.scrollTop + (r.top - c.top) - (bottom - c.top - r.height) / 2;
  box.scrollTo({ top: Math.max(0, top) });
}

/** Клавиатура уже открыта: поле, взявшее фокус, показывается сразу; иначе его покажет событие клавиатуры. */
function revealOnFocus(el: HTMLElement): void {
  if (document.documentElement.dataset.kb === 'open') requestAnimationFrame(() => reveal(el));
}

interface NumberFieldProps {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  disabled?: boolean;
  need?: boolean;
  invalid?: boolean;
  enterKeyHint?: 'next' | 'done';
  suffix?: string;
  /** Enter на клавиатуре с клавишей ввода: отправить карточку, если всё заполнено */
  onEnter?: () => void;
  /** Поле взяло фокус: карточка запоминает строку машины, куда ставить быстрые суммы */
  onFocus?: () => void;
  /** Полное имя поля для чтения с экрана, когда видимая подпись короткая («Стоимость машины 2, ₽») */
  ariaLabel?: string;
}

/** Числовое поле: цифры и пробелы между тысячами, курсор остаётся там, где был. */
function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  maxLength,
  disabled,
  need,
  invalid,
  enterKeyHint = 'next',
  suffix,
  onEnter,
  onFocus,
  ariaLabel,
}: NumberFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  // положение курсора после перегруппировки цифр; null: курсор в конце, браузер ставит его сам
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current !== null && el && document.activeElement === el) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  return (
    <div className="ff-field" data-need={need ? 'true' : undefined}>
      <label className="ff-label" htmlFor={id}>
        {label}
      </label>
      <div className="ff-input">
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9 ]*"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={enterKeyHint}
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onFocus={(e) => {
            onFocus?.();
            revealOnFocus(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            onEnter?.();
          }}
          onChange={(e) => {
            const el = e.currentTarget;
            const pos = el.selectionStart ?? el.value.length;
            const before = digits(el.value.slice(0, pos)).length;
            const next = group(digits(el.value).slice(0, maxLength));
            // курсор в середине числа остаётся после того же числа цифр, пробелы его не сдвигают;
            // в конце ничего делать не надо. Ставится в layout-эффекте сразу после обновления поля,
            // а не позже: быстрая печать не успевает уехать на старое место
            if (pos < el.value.length) {
              let seen = 0;
              let i = 0;
              while (i < next.length && seen < before) {
                if (/\d/.test(next[i]!)) seen++;
                i++;
              }
              caret.current = i;
            }
            onChange(next);
          }}
        />
        {suffix ? <span className="ff-suffix">{suffix}</span> : null}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="ff-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface UnitState {
  cost: string;
  rent: string;
}

/** Строк «Машина N» в состоянии всегда столько, сколько разных цен можно задать; показываются первые N. */
const UNIT_SLOTS = FLEET_MAX_DIFFERENT;
const CARS_MAX = 50;

const pos = (n: number | null): number | null => (n !== null && n > 0 ? n : null);

/** Ряд быстрых сумм с подписью «Быстро». Кнопки не отбирают фокус у поля: клавиатура остаётся открытой. */
function Quick({
  label,
  values,
  text,
  onPick,
  disabled,
  testId,
  who,
}: {
  label: string;
  values: readonly number[];
  text: (n: number) => string;
  onPick: (n: number) => void;
  disabled?: boolean;
  testId: string;
  /** Для какой машины подставится сумма (режим «разные цены») */
  who?: string;
}) {
  return (
    <div className="ff-quick" role="group" aria-label={label} data-testid={testId}>
      <span className="ff-quick-label">{who ? `Быстро, ${who}` : 'Быстро'}</span>
      <div className="qlist">
        {values.map((c) => (
          <button
            key={c}
            type="button"
            className="qreply"
            disabled={disabled}
            onPointerDown={hold}
            onMouseDown={hold}
            onClick={() => onPick(c)}
          >
            {text(c)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function FleetFormView({
  form,
  onSubmit,
  disabled,
  locked,
}: {
  form: FleetForm;
  onSubmit: (v: FleetFormSubmit) => void;
  /** Идёт отправка */
  disabled?: boolean;
  /** Карточка уже отправлена и после неё в чате есть ответ: поля только для чтения */
  locked?: boolean;
}) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const v = form.values;

  const [entityId, setEntityId] = useState<string | null>(v.entityId);
  const [cars, setCars] = useState(show(v.cars));
  const [sameOn, setSameOn] = useState(v.same);
  const [cost, setCost] = useState(show(v.cost));
  const [withVat, setWithVat] = useState(v.costWithVat);
  const [rent, setRent] = useState(show(v.rentPerDay));
  const [units, setUnits] = useState<UnitState[]>(() =>
    Array.from({ length: UNIT_SLOTS }, (_, i) => ({
      cost: show(v.units[i]?.cost ?? null),
      rent: show(v.units[i]?.rentPerDay ?? null),
    })),
  );
  // строка машины, где сейчас курсор: туда встают быстрые суммы
  const [active, setActive] = useState(() => {
    const i = v.units.findIndex((u) => u.cost === null || u.rentPerDay === null);
    return i < 0 ? 0 : i;
  });
  const [days, setDays] = useState(show(v.rentDays));
  const [start, setStart] = useState(v.startMonth);
  const [expenses, setExpenses] = useState(show(v.expenses));

  // клавиатура открылась или закрылась, пока поле в фокусе: поле остаётся в видимой части списка
  useEffect(() => {
    const on = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) {
        // клавиатура выезжает несколько кадров: поле встаёт на место, когда вьюпорт перестал меняться
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const now = document.activeElement;
          if (now instanceof HTMLElement && rootRef.current?.contains(now)) reveal(now);
        }, 120);
      }
    };
    let timer = 0;
    window.addEventListener(KEYBOARD_EVENT, on);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(KEYBOARD_EVENT, on);
    };
  }, []);

  const carsN = toNum(cars);
  const costN = toNum(cost);
  const rentN = toNum(rent);
  const daysN = toNum(days);
  const expN = toNum(expenses);
  const startOk = form.months.some((m) => m.value === start);

  const carsOk = carsN !== null && carsN >= 1 && carsN <= CARS_MAX;
  // больше 10 машин разные цены недоступны: переключатель включён и заблокирован, цена одна на всех
  const manyCars = carsN !== null && carsN > FLEET_MAX_DIFFERENT;
  const same = sameOn || manyCars;
  const rows = !same && carsOk ? carsN! : 0;
  const target = Math.min(active, Math.max(rows - 1, 0));

  // что ещё не заполнено; по этому списку подсказка над кнопкой и блокировка
  const left: string[] = [];
  if (entityId === null) left.push('Выберите юрлицо');
  if (!carsOk) left.push('Укажите, сколько машин: от 1 до 50');
  if (same) {
    if (pos(costN) === null) left.push('Укажите стоимость машины');
    if (pos(rentN) === null) left.push('Укажите цену сдачи');
  } else {
    for (let i = 0; i < rows; i++) {
      if (pos(toNum(units[i]!.cost)) === null) left.push(`Укажите стоимость машины ${i + 1}`);
      if (pos(toNum(units[i]!.rent)) === null) left.push(`Укажите цену сдачи машины ${i + 1}`);
    }
  }
  if (daysN === null || daysN < 1 || daysN > 31) left.push('Укажите дни сдачи в месяц: от 1 до 31');
  if (form.months.length === 0) left.push('Начать сдачу можно не раньше следующего месяца, а прогноз идёт до конца 2026 года');
  else if (!startOk) left.push('Выберите месяц начала');
  const ready = left.length === 0;

  // цены по машинам для итоговой строки и предупреждений: считает ядро, карточка только передаёт
  const prices: FleetUnitPrice[] = same
    ? Array.from({ length: carsOk ? carsN! : 0 }, () => ({ cost: pos(costN), rentPerDay: pos(rentN) }))
    : units.slice(0, rows).map((u) => ({ cost: pos(toNum(u.cost)), rentPerDay: pos(toNum(u.rent)) }));
  const live = fleetLiveLine(prices, daysN);
  const soft = fleetSoftWarnings(prices);

  const was = (f: 'entity' | 'cars' | 'cost' | 'rent') => !locked && form.mode === 'ask' && form.missing.includes(f);
  const off = Boolean(disabled || locked);

  const setUnit = (i: number, patch: Partial<UnitState>) =>
    setUnits((us) => us.map((u, k) => (k === i ? { ...u, ...patch } : u)));

  const toggleSame = (next: boolean) => {
    if (next) {
      // «разные» → «одинаковые»: общие поля берут первую машину, если сами пусты
      if (cost === '') setCost(units[0]!.cost);
      if (rent === '') setRent(units[0]!.rent);
    } else {
      // «одинаковые» → «разные»: пустые строки получают общие цены, их можно менять по машинам
      setUnits((us) => us.map((u) => ({ cost: u.cost || cost, rent: u.rent || rent })));
      setActive(0);
    }
    setSameOn(next);
  };

  const pickCost = (c: number) => (same ? setCost(show(c)) : setUnit(target, { cost: show(c) }));
  const pickRent = (c: number) => (same ? setRent(show(c)) : setUnit(target, { rent: show(c) }));

  const first = units[0]!;
  const canCopy = rows >= 2 && (first.cost !== '' || first.rent !== '');
  const copyFirst = () => setUnits((us) => us.map((u) => ({ cost: us[0]!.cost, rent: us[0]!.rent })));

  const submit = () => {
    if (!ready || off) return;
    onSubmit({
      entityId: entityId!,
      cars: carsN!,
      cost: same ? costN! : null,
      costWithVat: withVat,
      rentPerDay: same ? rentN! : null,
      units: same ? null : units.slice(0, rows).map((u) => ({ cost: toNum(u.cost)!, rentPerDay: toNum(u.rent)! })),
      rentDays: daysN!,
      startMonth: start,
      expenses: expN && expN > 0 ? expN : null,
    });
  };

  const shown = left.slice(0, 3);
  const leftText = `${shown.join('. ')}${left.length > 3 ? ` и ещё ${left.length - 3}` : ''}.`;

  const vatSeg = (
    <div
      className="ff-seg"
      role="radiogroup"
      aria-label="Стоимость покупки с НДС или без НДС"
    >
      {(
        [
          [true, 'с НДС'],
          [false, 'без НДС'],
        ] as const
      ).map(([flag, text]) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={withVat === flag}
          className={withVat === flag ? 'on' : undefined}
          disabled={off}
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={() => setWithVat(flag)}
        >
          {text}
        </button>
      ))}
    </div>
  );

  const rentHint = 'Цена, которую платит клиент, как есть: у плательщика НДС она с НДС, как и вся выручка в приложении.';

  return (
    // не <form>: в чате нет родительского form, чтобы Safari не рисовал над клавиатурой стрелки
    // «вверх, вниз» без нужды (DECISIONS.md); отправляет кнопка «Рассчитать»
    <div
      ref={rootRef}
      className="ff"
      data-form="fleet"
      data-mode={form.mode}
      role="group"
      aria-label="Параметры машин"
      onPointerDown={(e) => {
        // нажатие мимо полей и кнопок закрывает клавиатуру: на числовой клавиатуре iPhone нет клавиши «Готово»,
        // а чат вокруг карточки фокус с полей не снимает
        if (!(e.target instanceof Element) || e.target.closest('input, select, button, label')) return;
        const el = document.activeElement;
        if (el instanceof HTMLElement && rootRef.current?.contains(el)) el.blur();
      }}
    >
      {form.note ? (
        <p className="ff-note" role="alert">
          {form.note}
        </p>
      ) : null}

      <div className="ff-field" data-need={was('entity') && entityId === null ? 'true' : undefined}>
        <span className="ff-label" id={`${uid}-entity`}>
          Юрлицо
        </span>
        <div className="qlist" role="radiogroup" aria-labelledby={`${uid}-entity`}>
          {form.entities.map((e) => (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={entityId === e.id}
              className={entityId === e.id ? 'qreply on' : 'qreply'}
              disabled={off}
              onPointerDown={hold}
              onMouseDown={hold}
              onClick={() => setEntityId(e.id)}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ff-group">
        <NumberField
          id={`${uid}-cars`}
          label="Сколько машин"
          value={cars}
          onChange={setCars}
          maxLength={2}
          disabled={off}
          need={was('cars') && carsN === null}
          onEnter={submit}
        />
        <button
          type="button"
          role="switch"
          aria-checked={same}
          className="ff-switch"
          data-testid="ff-same"
          disabled={off || manyCars}
          aria-describedby={manyCars ? `${uid}-many` : undefined}
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={() => toggleSame(!sameOn)}
        >
          <span className="ff-switch-track" aria-hidden="true">
            <span className="ff-switch-knob" />
          </span>
          <span>Все машины одинаковые</span>
        </button>
        {manyCars ? (
          <p id={`${uid}-many`} className="ff-hint" data-testid="ff-many">
            Разные цены по машинам задаются до {FLEET_MAX_DIFFERENT} машин. Для {carsN} машин цена одна на всех.
          </p>
        ) : null}
      </div>

      {same ? (
        <>
          <div className="ff-group" data-need={was('cost') && costN === null ? 'true' : undefined}>
            <NumberField
              id={`${uid}-cost`}
              label="Стоимость одной машины, ₽"
              value={cost}
              onChange={setCost}
              maxLength={10}
              disabled={off}
              onEnter={submit}
            />
            {vatSeg}
            <p className="ff-hint">Стоимость покупки. «С НДС» выбрано сразу: у дилера машину обычно покупают с НДС.</p>
            {locked ? null : (
              <Quick label="Быстрые варианты стоимости" values={form.quick.cost} text={(c) => mln(c, 0)} onPick={pickCost} disabled={off} testId="ff-quick-cost" />
            )}
          </div>

          <div className="ff-group" data-need={was('rent') && rentN === null ? 'true' : undefined}>
            <div className="ff-pair">
              <NumberField
                id={`${uid}-rent`}
                label="Цена сдачи, ₽ в сутки"
                value={rent}
                onChange={setRent}
                maxLength={8}
                disabled={off}
                onEnter={submit}
              />
              <NumberField
                id={`${uid}-days`}
                label="Дней сдачи в месяц"
                value={days}
                onChange={setDays}
                maxLength={2}
                disabled={off}
                onEnter={submit}
              />
            </div>
            <p className="ff-hint">{rentHint}</p>
            {locked ? null : (
              <Quick label="Быстрые варианты цены сдачи" values={form.quick.rent} text={(c) => rub(c)} onPick={pickRent} disabled={off} testId="ff-quick-rent" />
            )}
          </div>
        </>
      ) : (
        <>
          <div className="ff-group">
            <span className="ff-label">Стоимость покупки</span>
            {vatSeg}
            <p className="ff-hint">«С НДС» выбрано сразу: у дилера машину обычно покупают с НДС.</p>
          </div>

          {rows === 0 ? (
            <p className="ff-hint" data-testid="ff-rows-hint">
              Укажите, сколько машин: для каждой появится строка со стоимостью и ценой сдачи.
            </p>
          ) : (
            <div className="ff-units" role="group" aria-label="Цены по машинам" data-testid="ff-units">
              {units.slice(0, rows).map((u, i) => (
                <div key={i} className="ff-unit" role="group" aria-label={`Машина ${i + 1}`} data-active={i === target ? 'true' : undefined}>
                  <span className="ff-unit-title">Машина {i + 1}</span>
                  <div className="ff-pair">
                    <NumberField
                      id={`${uid}-uc${i}`}
                      label="Стоимость, ₽"
                      ariaLabel={`Стоимость машины ${i + 1}, ₽`}
                      value={u.cost}
                      onChange={(x) => setUnit(i, { cost: x })}
                      maxLength={10}
                      disabled={off}
                      need={was('cost') && u.cost === ''}
                      onFocus={() => setActive(i)}
                      onEnter={submit}
                    />
                    <NumberField
                      id={`${uid}-ur${i}`}
                      label="Сдача, ₽ в сутки"
                      ariaLabel={`Цена сдачи машины ${i + 1}, ₽ в сутки`}
                      value={u.rent}
                      onChange={(x) => setUnit(i, { rent: x })}
                      maxLength={8}
                      disabled={off}
                      need={was('rent') && u.rent === ''}
                      onFocus={() => setActive(i)}
                      onEnter={submit}
                    />
                  </div>
                </div>
              ))}
              {rows >= 2 && !locked ? (
                <div className="ff-copy">
                  <button
                    type="button"
                    className="qreply"
                    data-testid="ff-copy-first"
                    disabled={off || !canCopy}
                    onPointerDown={hold}
                    onMouseDown={hold}
                    onClick={copyFirst}
                  >
                    Копировать первую на все
                  </button>
                  {!canCopy ? <p className="ff-hint">Сначала заполните машину 1.</p> : null}
                </div>
              ) : null}
            </div>
          )}

          {rows > 0 && !locked ? (
            <div className="ff-group">
              <Quick label="Быстрые варианты стоимости" values={form.quick.cost} text={(c) => mln(c, 0)} onPick={pickCost} disabled={off} testId="ff-quick-cost" who={`стоимость машины ${target + 1}`} />
              <Quick label="Быстрые варианты цены сдачи" values={form.quick.rent} text={(c) => rub(c)} onPick={pickRent} disabled={off} testId="ff-quick-rent" who={`цена сдачи машины ${target + 1}`} />
            </div>
          ) : null}

          <div className="ff-group">
            <NumberField
              id={`${uid}-days`}
              label="Дней сдачи в месяц (одинаково для всех машин)"
              value={days}
              onChange={setDays}
              maxLength={2}
              disabled={off}
              onEnter={submit}
            />
            <p className="ff-hint">{rentHint}</p>
          </div>
        </>
      )}

      <div className="ff-group">
        <p className="ff-calc" aria-live="polite" data-testid="ff-live">
          {live ?? 'Итог появится, когда заполнены число машин, стоимость и цена сдачи.'}
        </p>
        {soft.length > 0 ? (
          <ul className="ff-warn" role="status" data-testid="ff-warn">
            {soft.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="ff-field">
        <label className="ff-label" htmlFor={`${uid}-start`}>
          С какого месяца сдаём
        </label>
        <select
          id={`${uid}-start`}
          value={start}
          disabled={off || form.months.length === 0}
          onChange={(e) => setStart(Number(e.target.value))}
          onFocus={(e) => revealOnFocus(e.currentTarget)}
        >
          {form.months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <NumberField
        id={`${uid}-exp`}
        label="Расходы на машину в месяц, ₽ (необязательно)"
        hint="Лизинг, страховка, обслуживание"
        value={expenses}
        onChange={setExpenses}
        maxLength={10}
        disabled={off}
        enterKeyHint="done"
        onEnter={submit}
      />

      {locked ? (
        <p className="ff-hint">Карточка уже отправлена: актуальные значения в сообщении ниже.</p>
      ) : (
        // прижата к низу видимой области (sticky): при открытой клавиатуре «Рассчитать» не уходит под неё
        <div className="ff-bar">
          {!ready ? (
            <p className="ff-left" data-testid="ff-left">
              {leftText}
            </p>
          ) : null}
          <button type="button" className="act ff-go" disabled={!ready || off} onClick={submit}>
            Рассчитать
          </button>
        </div>
      )}
    </div>
  );
}

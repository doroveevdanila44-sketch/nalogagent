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
import { fleetRevenuePerCar, mln, rub } from '@/lib/calc';
import { KEYBOARD_EVENT } from '@/lib/client/keyboard';

/**
 * Карточка «Что если купим N машин»: поля, которые агент подставил из вопроса, и пустые, которые
 * он спрашивает. Пока обязательные поля не заполнены, «Рассчитать» не работает. Поля ввода числовые
 * (inputmode numeric, пробелы между тысячами), шрифт 16 px, чтобы iOS не увеличивал страницу.
 * Карточка ничего не считает, кроме строки «= … ₽ в месяц на машину»: её даёт та же функция ядра, что
 * считает выручку на машину в ответе.
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
  const bottom = composer ? Math.min(c.bottom, composer.top) : c.bottom;
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
          aria-invalid={invalid ? true : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onFocus={(e) => revealOnFocus(e.currentTarget)}
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
  const [cost, setCost] = useState(show(v.cost));
  const [withVat, setWithVat] = useState(v.costWithVat);
  // стоимость названа без «с НДС»: ни один вариант не выбран, пока человек не подтвердит
  const [vatChosen, setVatChosen] = useState(!form.confirmVat);
  const [rent, setRent] = useState(show(v.rentPerDay));
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

  // что ещё не заполнено; по этому списку подсказка над кнопкой и блокировка
  const left: string[] = [];
  if (entityId === null) left.push('юрлицо');
  if (carsN === null || carsN < 1 || carsN > 50) left.push('сколько машин');
  if (costN === null || costN <= 0) left.push('стоимость машины');
  if (!vatChosen) left.push('с НДС или без НДС');
  if (rentN === null || rentN <= 0) left.push('цена сдачи');
  if (daysN === null || daysN < 1 || daysN > 31) left.push('дней сдачи в месяц');
  if (!startOk) left.push('месяц начала');
  const ready = left.length === 0;

  const perCar = rentN && daysN && daysN >= 1 && daysN <= 31 ? fleetRevenuePerCar(rentN, daysN) : null;
  const was = (f: 'entity' | 'cars' | 'cost' | 'rent') => !locked && form.mode === 'ask' && form.missing.includes(f);
  const off = Boolean(disabled || locked);

  const submit = () => {
    if (!ready || off) return;
    onSubmit({
      entityId: entityId!,
      cars: carsN!,
      cost: costN!,
      costWithVat: withVat,
      rentPerDay: rentN!,
      rentDays: daysN!,
      startMonth: start,
      expenses: expN && expN > 0 ? expN : null,
    });
  };

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
        const active = document.activeElement;
        if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
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
        <div
          className="ff-seg"
          role="radiogroup"
          aria-label="Стоимость с НДС или без НДС"
          data-need={!vatChosen ? 'true' : undefined}
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
              aria-checked={vatChosen && withVat === flag}
              className={vatChosen && withVat === flag ? 'on' : undefined}
              disabled={off}
              onPointerDown={hold}
              onMouseDown={hold}
              onClick={() => {
                setWithVat(flag);
                setVatChosen(true);
              }}
            >
              {text}
            </button>
          ))}
        </div>
        {!vatChosen ? <p className="ff-hint">Стоимость названа без уточнения: в ней есть НДС?</p> : null}
        {form.mode === 'ask' && form.missing.includes('cost') && !locked ? (
          <div className="qlist" role="group" aria-label="Быстрые варианты стоимости">
            {form.quick.cost.map((c) => (
              <button
                key={c}
                type="button"
                className="qreply"
                disabled={off}
                onPointerDown={hold}
                onMouseDown={hold}
                onClick={() => setCost(show(c))}
              >
                {mln(c, 0)}
              </button>
            ))}
          </div>
        ) : null}
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
        {form.mode === 'ask' && form.missing.includes('rent') && !locked ? (
          <div className="qlist" role="group" aria-label="Быстрые варианты цены сдачи">
            {form.quick.rent.map((c) => (
              <button
                key={c}
                type="button"
                className="qreply"
                disabled={off}
                onPointerDown={hold}
                onMouseDown={hold}
                onClick={() => setRent(show(c))}
              >
                {rub(c)}
              </button>
            ))}
          </div>
        ) : null}
        <p className="ff-calc" aria-live="polite" data-testid="ff-per-car">
          {perCar ? `= ${rub(perCar)} в месяц на машину` : 'Выручка на машину в месяц = цена в сутки × дни'}
        </p>
      </div>

      <div className="ff-field">
        <label className="ff-label" htmlFor={`${uid}-start`}>
          С какого месяца сдаём
        </label>
        <select
          id={`${uid}-start`}
          value={start}
          disabled={off}
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
        <>
          {!ready ? (
            <p className="ff-left" data-testid="ff-left">
              Не заполнено: {left.join(', ')}
            </p>
          ) : null}
          <button type="button" className="act ff-go" disabled={!ready || off} onClick={submit}>
            Рассчитать
          </button>
        </>
      )}
    </div>
  );
}

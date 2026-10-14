import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeLive, computeStatic, mln, moment } from '@/lib/calc';
import { seedInput } from '@/lib/calc/demo-data';
import { groupMetrics } from '@/components/dashboard/group-metrics';
import {
  CHAPTER_TITLE,
  FULL_TOUR_STEPS,
  LINE_LABELS,
  TOUR_STEPS,
  stepLines,
  stepTitle,
  tourAttributes,
  type ChapterId,
} from '@/components/onboarding/chapters';
import { tourNumbers } from '@/components/onboarding/numbers';

/** Фиксированный момент, как в CALC.md: 2026-10-10 12:00:00 */
const T = moment(2026, 10, 10, 12, 0, 0);
const input = seedInput(T);
const stat = computeStatic(input, T);
const live = computeLive(input, T, stat);
const n = tourNumbers(input, stat, live, 2026);

const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2012)}-${String.fromCharCode(0x2015)}]`);
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
const read = (f: string) => fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');

/** Исходники интерфейса одним текстом: по нему проверяем, что у меток data-tour есть место в разметке. */
function sources(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.resolve(process.cwd(), dir));
  return out.join('\n');
}

/** Единственный шаг первого показа, которого нет в полном туре: меню одним шагом */
const MENU_SHORT = TOUR_STEPS.find((s) => s.id === 'menu')!;

describe('обучение: шаги', () => {
  it('в каждом шаге три строки с метками «Что это», «Как читать», «Что делать»', () => {
    expect(LINE_LABELS.map((l) => l.label)).toEqual(['Что это', 'Как читать', 'Что делать']);
    for (const step of [...FULL_TOUR_STEPS, ...TOUR_STEPS]) {
      for (const numbers of [null, n]) {
        const lines = stepLines(step, numbers, { asked: false });
        expect(lines.map((l) => l.label), step.id).toEqual(['Что это', 'Как читать', 'Что делать']);
        for (const l of lines) {
          expect(l.text.trim().length, `${step.id}/${l.key}`).toBeGreaterThan(8);
          // короткие фразы: не больше двух предложений и не длиннее 190 знаков
          expect(l.text.length, `${step.id}/${l.key}: ${l.text}`).toBeLessThanOrEqual(190);
        }
      }
    }
  });

  it('заголовок короткий, тексты без длинных тире, идентификаторы разные', () => {
    const ids = new Set<string>();
    for (const step of [...FULL_TOUR_STEPS, MENU_SHORT]) {
      expect(ids.has(step.id), `повтор ${step.id}`).toBe(false);
      ids.add(step.id);
      const title = stepTitle(step, n);
      expect(title.split(/\s+/).length, title).toBeLessThanOrEqual(6);
      const all = [title, ...stepLines(step, n, { asked: true }).map((l) => l.text)].join('\n');
      expect(LONG_DASH.test(all), `${step.id}: длинное тире`).toBe(false);
    }
  });

  it('главы идут подряд: Агент, Дашборд, Документы, Меню', () => {
    for (const steps of [TOUR_STEPS, FULL_TOUR_STEPS]) {
      const order: ChapterId[] = [];
      for (const s of steps) if (order[order.length - 1] !== s.chapter) order.push(s.chapter);
      expect(order).toEqual(['agent', 'dashboard', 'documents', 'menu']);
    }
    expect(Object.values(CHAPTER_TITLE)).toEqual(['Агент', 'Дашборд', 'Документы', 'Меню']);
  });

  it('в полном туре есть шаги про выбор налога и про «Отправить на проверку» (на дашборде и в ответе агента)', () => {
    const byId = (id: string) => FULL_TOUR_STEPS.find((s) => s.id === id)!;
    const sw = stepLines(byId('tax-switch'), n);
    expect(sw[2]!.text).toContain('«Налог на прибыль»');
    expect(sw[2]!.text).toContain('«Налог по УСН»');
    expect(byId('tax-switch').prepare).toBe('calc-profit');

    const sp = byId('specialist');
    expect(sp.chapter).toBe('dashboard');
    expect(stepTitle(sp, n)).toBe('Отправить на проверку');
    expect(stepLines(sp, n).map((l) => l.text).join(' ')).toContain('«Что проверено»');
    expect(stepLines(sp, n).map((l) => l.text).join(' ')).toMatch(/комментарием или согласованием/);
    expect(byId('answer-specialist').chapter).toBe('agent');

    const act = stepLines(byId('actions'), n)[1]!.text;
    for (const b of ['Показать расчёт', 'Выгрузить в Excel', 'Проверить самому', 'Отправить на проверку']) {
      expect(act).toContain(`«${b}»`);
    }
  });

  it('полный тур: главы содержат нужные шаги', () => {
    const ids = (c: ChapterId) => FULL_TOUR_STEPS.filter((s) => s.chapter === c).map((s) => s.id);
    expect(ids('dashboard')).toEqual([
      'banner-revenue',
      'banner-vat',
      'banner-vat-forecast',
      'banner-profit',
      'warnings',
      'chart',
      'entity',
      'rates',
      'tax-switch',
      'actions',
      'specialist',
    ]);
    expect(ids('agent')).toEqual(['ask', 'suggestions', 'forecast', 'edit', 'quick', 'answer-specialist']);
    expect(ids('documents')).toEqual([
      'doc-catalog',
      'doc-fill',
      'doc-bar',
      'doc-menu',
      'doc-send',
      'doc-status',
    ]);
    expect(ids('menu')).toEqual(['menu-lock', 'menu-pin']);
  });

  it('первый показ: восемь шагов, по два-три на раздел и один про меню', () => {
    expect(TOUR_STEPS.length).toBe(8);
    const ids = (c: ChapterId) => TOUR_STEPS.filter((s) => s.chapter === c).map((s) => s.id);
    expect(ids('agent')).toEqual(['ask', 'suggestions']);
    expect(ids('dashboard')).toEqual(['banner-vat-forecast', 'warnings', 'actions']);
    expect(ids('documents')).toEqual(['doc-catalog', 'doc-fill']);
    expect(ids('menu')).toEqual(['menu']);
    // по два-три шага на каждый из трёх разделов
    for (const c of ['agent', 'dashboard', 'documents'] as const) {
      expect(ids(c).length, c).toBeGreaterThanOrEqual(2);
      expect(ids(c).length, c).toBeLessThanOrEqual(3);
    }
    // шаги первого показа те же, что в полном туре, кроме меню (оно одним шагом)
    for (const s of TOUR_STEPS.filter((x) => x.id !== 'menu')) {
      expect(FULL_TOUR_STEPS.find((x) => x.id === s.id), s.id).toBe(s);
    }
  });

  it('шаг про меню называет «Показать подсказки заново»: остальные подсказки по кнопке', () => {
    const menu = stepLines(MENU_SHORT, n).map((l) => l.text).join(' ');
    expect(menu).toContain('«Показать подсказки заново»');
    expect(MENU_SHORT.targets).toEqual(['[data-tour="menu-sheet"]']);
    expect(MENU_SHORT.menu).toBe(true);
  });

  it('подсказки «Что если» названы в шаге про подсказки', () => {
    const step = FULL_TOUR_STEPS.find((s) => s.id === 'suggestions')!;
    const text = stepLines(step, n).map((l) => l.text).join(' ');
    expect(text).toContain('«Что если»');
    expect(text).toContain('«Сценарий, а не прогноз»');
  });

  it('полный тур: 25 шагов, последний «Сменить PIN» с отсылкой к «Показать подсказки заново»', () => {
    expect(FULL_TOUR_STEPS.length).toBe(25);
    const last = FULL_TOUR_STEPS[FULL_TOUR_STEPS.length - 1]!;
    expect(last.id).toBe('menu-pin');
    expect(stepLines(last, n)[2]!.text).toContain('«Показать подсказки заново»');
    const ids = FULL_TOUR_STEPS.map((s) => s.id);
    expect(ids).not.toContain('doc-sheet');
    expect(ids).not.toContain('menu-tour');
    // соседние шаги главы «Документы» не ссылаются на лист документа и жёлтые поля
    for (const id of ['doc-fill', 'doc-bar', 'doc-menu', 'doc-send', 'doc-status']) {
      const step = FULL_TOUR_STEPS.find((s) => s.id === id)!;
      const text = stepLines(step, n).map((l) => l.text).join(' ');
      expect(text, id).not.toMatch(/жёлт|как лист|Страница документа/);
    }
  });

  it('прежних названий нет: «Передать специалисту», «Статусы проверок», «Пересмотреть обучение»', () => {
    for (const step of [...FULL_TOUR_STEPS, ...TOUR_STEPS]) {
      const all = [stepTitle(step, n), ...stepLines(step, n).map((l) => l.text)].join(' ');
      expect(all, step.id).not.toMatch(/Передать специалисту|Статус\w* проверок|Пересмотреть обучение/);
    }
  });
});

describe('обучение: живые числа из расчёта', () => {
  const banners = groupMetrics(live, stat, input.entities, 2026);
  const metric = (id: string) => banners.find((b) => b.id === id)!;

  it('числа в карточках те же, что в баннерах дашборда', () => {
    expect(n.vatForecast).toBe(metric('vatForecast').value);
    expect(n.vatSplit).toBe(metric('vatForecast').sub[0]);
    expect(n.profit).toBe(metric('profit').value);
    expect(metric('profit').sub.join(' ')).toContain(n.usn);
    expect(n.revenue).toBe(mln(live.ytdGroup, 2));
    expect(n.vatAccrued).toBe(mln(live.taxAccruedGroup, 2));
  });

  it('число встаёт в строку шага, а без расчёта строка читается без числа', () => {
    const step = (id: string) => FULL_TOUR_STEPS.find((s) => s.id === id)!;
    expect(stepLines(step('banner-revenue'), n)[0]!.text).toContain(n.revenue);
    expect(stepLines(step('banner-revenue'), null)[0]!.text).not.toContain('млн');
    expect(stepLines(step('banner-vat'), n)[0]!.text).toContain(n.vatAccrued);
    expect(stepLines(step('banner-vat-forecast'), n)[0]!.text).toContain(n.vatForecast);
    expect(stepLines(step('banner-vat-forecast'), n)[1]!.text).toContain(n.vatSplit);
    expect(stepTitle(step('banner-vat-forecast'), n)).toBe('НДС за 2026 год, прогноз');
    expect(stepTitle(step('banner-profit'), n)).toBe('Налог на прибыль за 2026 год');
    const profit = stepLines(step('banner-profit'), n);
    expect(profit[0]!.text).toContain('Эпсилон');
    expect(profit[0]!.text).toContain(n.profit);
    expect(profit[0]!.text).toContain(n.usn);
    // сроки авансов из графика платежей: 28 апреля, июля и октября
    expect(profit[2]!.text).toContain('28 апреля, июля и октября');
  });

  it('порог, освобождённое юрлицо и ставки взяты из расчёта', () => {
    // между числом и «млн» стоит неразрывный пробел
    expect(plain(n.threshold)).toBe('20 млн');
    expect(n.exempt?.name).toBe('ИП Дельта');
    expect(plain(n.exempt!.limit)).toBe('20 млн');
    expect(n.rates?.name).toBe('Альфа');
    expect(n.rates?.items.map((r) => r.rate)).toEqual([5, 7, 22]);
    const rates = stepLines(FULL_TOUR_STEPS.find((s) => s.id === 'rates')!, n)[2]!.text;
    for (const r of n.rates!.items) expect(rates).toContain(`${r.rate}% ${r.sum}`);
    expect(stat.warnings.length).toBe(n.warningsTotal);
    expect(n.bestMonth).not.toBeNull();
  });

  it('строка про пример ответа агента зависит от того, задал ли вопрос тур', () => {
    const forecast = FULL_TOUR_STEPS.find((s) => s.id === 'forecast')!;
    expect(stepLines(forecast, n, { asked: true })[2]!.text).toContain('мы задали этот вопрос за вас');
    expect(stepLines(forecast, n, { asked: false })[2]!.text).not.toContain('за вас');
  });
});

describe('обучение: метки data-tour есть в разметке', () => {
  const ui = sources('components');

  it('каждый селектор шага это data-tour и этот атрибут стоит в компонентах', () => {
    for (const step of TOUR_STEPS) {
      for (const t of step.targets) expect(t, `${step.id}: ${t}`).toMatch(/^\[data-tour="[a-z-]+"\]$/);
    }
    const missing = tourAttributes().filter((name) => {
      // кнопки действий получают метку по идентификатору: data-tour={`act-${id}`}
      if (name.startsWith('act-')) {
        return !ui.includes('data-tour={`act-${id}`}') || !new RegExp(`\\b${name.slice(4)}: '`).test(read('components/provenance/CalcActions.tsx'));
      }
      return !new RegExp(`data-tour=(\\{)?["'\`]${name}["'\`]|['"]${name}['"]`).test(ui);
    });
    expect(missing).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * watchKeyboard без браузера: вместо window, document и visualViewport подставлены заглушки, которые
 * считают подписки. Проверяется то, что нельзя увидеть юнит-тестом формул: переменные ставятся из
 * значений visualViewport, подписки на размонтировании снимаются все, отложенные проверки не живут
 * после него.
 */

type Listener = (e: unknown) => void;

function target(name: string, log: string[]) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener(type: string, fn: Listener) {
      log.push(`+${name}:${type}`);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      log.push(`-${name}:${type}`);
      listeners.get(type)?.delete(fn);
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn({ target: null });
    },
  };
}

class FakeTextArea {}
class FakeInput {
  type = 'text';
}

let log: string[];
let vars: Record<string, string>;
let dataset: Record<string, string>;
let vv: ReturnType<typeof target> & { height: number; offsetTop: number; scale: number };
let win: ReturnType<typeof target> & Record<string, unknown>;
let doc: ReturnType<typeof target> & Record<string, unknown>;
let events: string[];

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  vars = {};
  dataset = {};
  events = [];
  vv = Object.assign(target('vv', log), { height: 844, offsetTop: 0, scale: 1 });
  win = Object.assign(target('win', log), {
    innerHeight: 844,
    scrollX: 0,
    scrollY: 0,
    visualViewport: vv,
    matchMedia: () => ({ matches: true }),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    scrollTo: vi.fn(),
    dispatchEvent: (e: { type: string; detail: { open: boolean } }) => events.push(`${e.type}:${e.detail.open}`),
  });
  doc = Object.assign(target('doc', log), {
    activeElement: null as unknown,
    scrollingElement: null,
    documentElement: {
      dataset,
      style: {
        setProperty: (k: string, v: string) => void (vars[k] = v),
        removeProperty: (k: string) => void delete vars[k],
      },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  Object.assign(globalThis, {
    window: win,
    document: doc,
    HTMLTextAreaElement: FakeTextArea,
    HTMLInputElement: FakeInput,
    HTMLElement: class {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ['window', 'document', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLElement']) {
    delete (globalThis as Record<string, unknown>)[k];
  }
});

async function mount() {
  const { watchKeyboard } = await import('./keyboard');
  return watchKeyboard();
}

describe('watchKeyboard', () => {
  it('без клавиатуры: --vvh на всё окно, --kb и --vv-top 0, data-kb нет', async () => {
    const stop = await mount();
    expect(vars['--vvh']).toBe('844px');
    expect(vars['--kb']).toBe('0px');
    expect(vars['--vv-top']).toBe('0px');
    expect(dataset.kb).toBeUndefined();
    stop();
  });

  it('фокус в поле и visualViewport на 336 px ниже: --vvh, --kb, data-kb, событие', async () => {
    const stop = await mount();
    doc.activeElement = new FakeTextArea();
    vv.height = 508;
    vv.emit('resize');
    expect(vars['--vvh']).toBe('508px');
    expect(vars['--kb']).toBe('336px');
    expect(dataset.kb).toBe('open');
    expect(events.at(-1)).toBe('pva:keyboard:true');
    // Safari сдвинул видимую область: --vv-top, высота клавиатуры та же
    vv.offsetTop = 120;
    vv.emit('scroll');
    expect(vars['--vv-top']).toBe('120px');
    expect(vars['--kb']).toBe('336px');
    // resize visualViewport возвращает окно в (0, 0), если iOS его прокрутил
    win.scrollY = 40;
    vv.emit('resize');
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    stop();
  });

  it('клавиатура закрылась: переменные возвращаются, приходит событие закрытия', async () => {
    const stop = await mount();
    doc.activeElement = new FakeTextArea();
    vv.height = 508;
    vv.emit('resize');
    doc.activeElement = null;
    vv.height = 844;
    vv.offsetTop = 0;
    vv.emit('resize');
    expect(vars['--vvh']).toBe('844px');
    expect(vars['--kb']).toBe('0px');
    expect(dataset.kb).toBeUndefined();
    expect(events.at(-1)).toBe('pva:keyboard:false');
    stop();
  });

  it('blur: высота перечитывается сразу, через 150 и 350 мс (iOS оставляет старую высоту)', async () => {
    const stop = await mount();
    doc.activeElement = new FakeTextArea();
    vv.height = 508;
    vv.emit('resize');
    doc.activeElement = null;
    doc.emit('focusout');
    // visualViewport ещё старый, потом iOS его обновляет
    vv.height = 844;
    win.scrollY = 30;
    vi.advanceTimersByTime(0);
    expect(vars['--kb']).toBe('0px');
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    vi.advanceTimersByTime(400);
    expect(vars['--vvh']).toBe('844px');
    stop();
  });

  it('размонтирование снимает все подписки, переменные и отложенные проверки', async () => {
    const stop = await mount();
    doc.emit('focusout'); // три отложенные проверки
    stop();
    const added = log.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).sort();
    const removed = log.filter((l) => l.startsWith('-')).map((l) => l.slice(1)).sort();
    // focusin, focusout, resize, orientationchange, visualViewport resize и scroll
    expect(added).toHaveLength(6);
    expect(removed).toEqual(added);
    for (const set of [doc.listeners, win.listeners, vv.listeners] as Map<string, Set<Listener>>[]) {
      for (const [type, fns] of set) expect(fns.size, type).toBe(0);
    }
    expect(vars).toEqual({});
    expect(dataset.kb).toBeUndefined();
    // отложенные проверки не срабатывают после размонтирования
    win.scrollTo = vi.fn();
    win.scrollY = 50;
    vi.advanceTimersByTime(1000);
    expect(win.scrollTo).not.toHaveBeenCalled();
    expect(vars).toEqual({});
  });
});

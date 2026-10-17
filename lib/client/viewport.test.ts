import { describe, expect, it } from 'vitest';
import { KEYBOARD_THRESHOLD, computeKeyboard, type ViewportMetrics } from './viewport';

/** iPhone 14 в установленном приложении: окно 390 на 844, клавиатура без панели подсказок 336 px. */
const IPHONE: ViewportMetrics = {
  innerHeight: 844,
  vvHeight: 844,
  vvOffsetTop: 0,
  vvScale: 1,
  baseInnerHeight: 844,
  focusedText: true,
  coarse: true,
};

const with_ = (over: Partial<ViewportMetrics>): ViewportMetrics => ({ ...IPHONE, ...over });

describe('сдвиг экранной клавиатуры по visualViewport', () => {
  it('клавиатуры нет: видимая область на всё окно, --kb 0', () => {
    expect(computeKeyboard(IPHONE)).toEqual({ open: false, vvh: 844, kb: 0, top: 0 });
  });

  it('iOS: клавиатура 336 px уменьшила только visualViewport, innerHeight прежний', () => {
    const g = computeKeyboard(with_({ vvHeight: 508 }));
    expect(g).toEqual({ open: true, vvh: 508, kb: 336, top: 0 });
  });

  it('iOS: Safari сдвинул видимую область на 120 px: высота клавиатуры та же, оболочка встаёт на сдвиг', () => {
    const g = computeKeyboard(with_({ vvHeight: 508, vvOffsetTop: 120 }));
    expect(g).toEqual({ open: true, vvh: 508, kb: 336, top: 120 });
    // видимая область целиком внутри окна: сдвиг плюс высота не больше innerHeight
    expect(g.top + g.vvh!).toBeLessThanOrEqual(844);
  });

  it('iPhone SE 375 на 667: клавиатура 291 px', () => {
    const se = with_({ innerHeight: 667, vvHeight: 667, baseInnerHeight: 667 });
    expect(computeKeyboard(se)).toEqual({ open: false, vvh: 667, kb: 0, top: 0 });
    expect(computeKeyboard({ ...se, vvHeight: 376 })).toEqual({ open: true, vvh: 376, kb: 291, top: 0 });
  });

  it('Chrome на Android: раскладочный вьюпорт сжался сам, visualViewport равен innerHeight', () => {
    const g = computeKeyboard(with_({ innerHeight: 508, vvHeight: 508 }));
    expect(g).toEqual({ open: true, vvh: 508, kb: 336, top: 0 });
  });

  it('граница 80 px: ровно 80 клавиатурой не считается, 81 считается', () => {
    expect(KEYBOARD_THRESHOLD).toBe(80);
    expect(computeKeyboard(with_({ vvHeight: 764 })).open).toBe(false);
    expect(computeKeyboard(with_({ vvHeight: 764 })).kb).toBe(0);
    expect(computeKeyboard(with_({ vvHeight: 763 })).open).toBe(true);
    expect(computeKeyboard(with_({ vvHeight: 763 })).kb).toBe(81);
    // то же для сжатия раскладочного вьюпорта
    expect(computeKeyboard(with_({ innerHeight: 764, vvHeight: 764 })).open).toBe(false);
    expect(computeKeyboard(with_({ innerHeight: 763, vvHeight: 763 })).open).toBe(true);
  });

  it('видимая область уменьшилась без фокуса в поле (панель адреса): клавиатуры нет, --vvh всё равно точный', () => {
    const g = computeKeyboard(with_({ vvHeight: 700, focusedText: false }));
    expect(g).toEqual({ open: false, vvh: 700, kb: 0, top: 0 });
  });

  it('компьютер без касания: клавиатуры нет, даже если окно уменьшили', () => {
    const g = computeKeyboard(with_({ innerHeight: 500, vvHeight: 500, coarse: false }));
    expect(g.open).toBe(false);
    expect(g.kb).toBe(0);
    expect(g.vvh).toBe(500);
  });

  it('увеличение пальцами: visualViewport уменьшился сам, клавиатурой не считается, --vvh снимается', () => {
    const g = computeKeyboard(with_({ vvHeight: 400, vvScale: 2, vvOffsetTop: 90 }));
    expect(g).toEqual({ open: false, vvh: null, kb: 0, top: 0 });
  });

  it('нет visualViewport: --vvh снимается, клавиатуру выдаёт сжатие окна', () => {
    expect(computeKeyboard(with_({ vvHeight: null }))).toEqual({ open: false, vvh: null, kb: 0, top: 0 });
    expect(computeKeyboard(with_({ vvHeight: null, innerHeight: 520 }))).toEqual({
      open: true,
      vvh: null,
      kb: 324,
      top: 0,
    });
  });

  it('дробные значения округляются, отрицательные сдвиги обнуляются', () => {
    const g = computeKeyboard(with_({ vvHeight: 507.6, vvOffsetTop: -3.2 }));
    expect(g).toEqual({ open: true, vvh: 508, kb: 336, top: 0 });
    // резинка Safari у верхнего края даёт отрицательный offsetTop при закрытой клавиатуре
    expect(computeKeyboard(with_({ vvOffsetTop: -12, focusedText: false })).top).toBe(0);
  });

  it('клавиатура закрылась: --kb и сдвиг снова 0, --vvh на всё окно', () => {
    const open = computeKeyboard(with_({ vvHeight: 508, vvOffsetTop: 120 }));
    const closed = computeKeyboard(with_({ vvHeight: 844, vvOffsetTop: 0, focusedText: false }));
    expect(open.kb).toBeGreaterThan(KEYBOARD_THRESHOLD);
    expect(closed).toEqual({ open: false, vvh: 844, kb: 0, top: 0 });
  });
});

/** Shared mobile header. Scroll sets a target, and animation frames smooth the visual position. */
export function attachRoborabHeader(header, status, options = {}) {
  const mobile = window.matchMedia('(max-width: 899px)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const offsetHost = options.offsetHost || header;
  const positions = new WeakMap();
  let height = 0;
  let strip = 0;
  let target = 0;
  let shown = 0;
  let frame = 0;
  let lastFrame = 0;
  let glassTheme;

  function setGlassTheme(glass) {
    if (glassTheme === glass) return;
    glassTheme = glass;
    if (options.onGlass) options.onGlass(glass);
    else {
      const color = glass ? '#f5f2fc' : '#6a2cf0';
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = color;
    }
  }

  function paint() {
    const opacity = strip ? Math.max(0, (shown - height + strip) / strip) : 0;
    offsetHost.style.setProperty('--rr-header-shift', `${-shown.toFixed(2)}px`);
    status.style.opacity = opacity;
    const hidden = height > 0 && shown >= height;
    header.toggleAttribute('data-rr-header-hidden', hidden);
    setGlassTheme(hidden || opacity >= .5);
  }

  function animate(now) {
    const dt = lastFrame ? Math.min(32, now - lastFrame) : 1000 / 60;
    lastFrame = now;
    shown += (target - shown) * (1 - Math.exp(-dt / 30));
    if (Math.abs(target - shown) < .25) shown = target;
    paint();
    frame = shown === target ? 0 : requestAnimationFrame(animate);
    if (!frame) lastFrame = 0;
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = lastFrame = 0;
  }

  function readPosition(source) {
    return Math.max(0, Math.min(source.scrollTop, source.scrollHeight - source.clientHeight));
  }

  function seed() {
    if (options.scrollSelector) {
      for (const source of document.querySelectorAll(options.scrollSelector)) {
        positions.set(source, readPosition(source));
      }
    } else if (document.scrollingElement) {
      positions.set(document.scrollingElement, readPosition(document.scrollingElement));
    }
  }

  function measure() {
    height = header.offsetHeight;
    strip = status.offsetHeight;
    target = Math.min(target, height);
    shown = Math.min(shown, height);
    paint();
  }

  function reset() {
    stop();
    target = shown = 0;
    seed();
    measure();
  }

  function onScroll(event) {
    if (!mobile.matches) return;
    const source = event.target === document ? document.scrollingElement : event.target;
    if (!(source instanceof HTMLElement)) return;
    if (options.scrollSelector ? !source.matches(options.scrollSelector) : source !== document.scrollingElement) return;

    const current = readPosition(source);
    const previous = positions.get(source) ?? current;
    positions.set(source, current);
    const next = current === 0 || options.paused?.() || header.querySelector(':focus-visible')
      ? 0 : Math.max(0, Math.min(height, target + current - previous));
    if (next === target) return;
    target = next;
    if (reduced.matches) {
      stop();
      shown = target;
      paint();
    } else if (!frame) {
      frame = requestAnimationFrame(animate);
    }
  }

  function focus() {
    if (header.querySelector(':focus-visible')) reset();
  }

  const observer = new ResizeObserver(measure);
  observer.observe(header);
  observer.observe(status);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('pageshow', reset);
  mobile.addEventListener('change', reset);
  reduced.addEventListener('change', reset);
  header.addEventListener('focusin', focus);
  document.addEventListener('rr:header-reset', reset);
  document.addEventListener('rr:header-seed', seed);
  reset();

  return () => {
    stop();
    observer.disconnect();
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pageshow', reset);
    mobile.removeEventListener('change', reset);
    reduced.removeEventListener('change', reset);
    header.removeEventListener('focusin', focus);
    document.removeEventListener('rr:header-reset', reset);
    document.removeEventListener('rr:header-seed', seed);
    offsetHost.style.removeProperty('--rr-header-shift');
    status.style.removeProperty('opacity');
    header.removeAttribute('data-rr-header-hidden');
  };
}

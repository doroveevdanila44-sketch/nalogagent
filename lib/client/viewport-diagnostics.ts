/** Снимок геометрии для проверки полосы у нижнего края установленного НДС. */
function viewportReport(): string {
  const { screen, visualViewport: vv } = window;
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
  const frame = rect('.app-viewport');
  const dock = rect('.rr-dock .rr-tab');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;width:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  let heights: string;
  try {
    heights = ['vh', 'dvh', 'svh', 'lvh'].map((unit) => {
      probe.style.height = '0px';
      probe.style.height = `100${unit}`;
      return `${unit}=${probe.offsetHeight}`;
    }).join(' ');
  } finally {
    probe.remove();
  }

  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone
    || matchMedia('(display-mode: standalone)').matches;
  const statusBar = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
  const px = (value?: number) => value === undefined ? '—' : Math.round(value);
  return [
    `НДС · ${location.hostname} · ${standalone ? 'экран «Домой»' : 'браузер'}`,
    `Экран ${screen.width}×${screen.height} · доступно ${screen.availHeight}`,
    `Окно ${innerWidth}×${innerHeight} · корень ${root.clientHeight}`,
    `Видимая область ${px(vv?.height)} · сдвиг ${px(vv?.offsetTop)} · масштаб ${vv?.scale ?? '—'}`,
    `Высоты CSS ${heights}`,
    `Край приложения ${px(frame?.bottom)} · край плитки ${px(dock?.bottom)}`,
    `Отступы iOS ${css.getPropertyValue('--safe-top').trim()} / ${css.getPropertyValue('--safe-bottom').trim()} · для тачбара ${css.getPropertyValue('--rr-safe-bottom').trim()}`,
    `Статус-бар ${statusBar?.content ?? 'авто'} · прокрутка ${px(scrollY)}`,
  ].join('\n');
}

export async function copyViewportDiagnostics(): Promise<void> {
  const report = viewportReport();
  try {
    await navigator.clipboard.writeText(report);
  } catch {
    window.prompt('Скопируйте параметры экрана', report);
    return;
  }
  window.alert('Параметры экрана скопированы. Вставьте их в чат.');
}

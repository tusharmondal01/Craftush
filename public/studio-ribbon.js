(() => {
  'use strict';
  const stage = document.querySelector('.hero-ribbon');
  if (!stage) return;
  const tiles = [...stage.querySelectorAll('.ribbon-tile')];
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, tileWidth = 168, stride = 186, cycle = 0;
  let offset = 0, frame = 0, previousTime = 0, inView = true;

  const render = () => {
    tiles.forEach((tile, index) => {
      const x = ((index * stride - offset) % cycle + cycle) % cycle - stride;
      const distance = Math.max(-1, Math.min(1, (x + tileWidth / 2 - width / 2) / (width / 2 + tileWidth)));
      const curve = distance * distance;
      tile.style.transform = `translate3d(${x.toFixed(2)}px,calc(-50% - ${(curve * 7).toFixed(2)}px),${(curve * 58).toFixed(2)}px) rotateY(${(-distance * 19).toFixed(2)}deg) scale(${(1 + curve * .05).toFixed(3)})`;
      tile.style.zIndex = String(Math.round(curve * 10));
    });
  };
  const shouldRun = () => stage.isConnected && inView && !document.hidden && !preference.matches && document.documentElement.dataset.motion !== 'paused';
  const tick = time => {
    frame = 0;
    if (!shouldRun()) { previousTime = 0; return; }
    const elapsed = previousTime ? Math.min(50, time - previousTime) : 0;
    previousTime = time;
    offset = (offset + elapsed * (width < 650 ? .027 : .037)) % cycle;
    render();
    frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    if (shouldRun()) {
      if (!frame) { previousTime = 0; frame = requestAnimationFrame(tick); }
    } else {
      cancelAnimationFrame(frame); frame = 0; previousTime = 0;
    }
  };
  const resize = () => {
    width = stage.getBoundingClientRect().width;
    tileWidth = Math.max(110, Math.min(168, width / 7.2));
    stride = tileWidth + (width < 650 ? 14 : 19);
    cycle = stride * tiles.length;
    tiles.forEach(tile => {
      tile.style.width = tileWidth + 'px';
      tile.style.height = (tileWidth * 16 / 9) + 'px';
    });
    offset %= cycle;
    render();
    sync();
  };
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  else addEventListener('resize', resize);
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    sync();
  }, { rootMargin: '30px' }).observe(stage);
  document.addEventListener('craftush:motion', sync);
  document.addEventListener('visibilitychange', sync);
  preference.addEventListener('change', sync);
  resize();
})();

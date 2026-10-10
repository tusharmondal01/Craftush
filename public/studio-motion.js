(() => {
  'use strict';
  const root = document.documentElement;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const toggle = document.getElementById('motionToggle');
  let userPaused = false;
  const updateMotion = () => {
    const paused = userPaused || preference.matches;
    root.dataset.motion = paused ? 'paused' : 'running';
    root.dataset.pageVisible = document.hidden ? 'false' : 'true';
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.setAttribute('aria-label', paused ? 'Play animations' : 'Pause animations');
      toggle.querySelector('span').textContent = paused ? 'Motion off' : 'Motion on';
      toggle.disabled = preference.matches;
      toggle.title = preference.matches ? 'Reduced motion is enabled on your device.' : (paused ? 'Play page animations' : 'Pause page animations');
    }
    document.dispatchEvent(new Event('craftush:motion'));
  };
  toggle?.addEventListener('click', () => { userPaused = !userPaused; updateMotion(); });
  preference.addEventListener('change', updateMotion);
  document.addEventListener('visibilitychange', updateMotion);
  updateMotion();

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.dataset.inView = String(entry.isIntersecting);
    }, { rootMargin: '30px' });
    document.querySelectorAll('.motion-stage').forEach(stage => observer.observe(stage));
  }
  const hero = document.querySelector('.hero-art');
  if (hero && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    let frame = 0;
    hero.addEventListener('pointermove', event => {
      if (root.dataset.motion !== 'running' || frame) return;
      const bounds = hero.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - .5;
      const y = (event.clientY - bounds.top) / bounds.height - .5;
      frame = requestAnimationFrame(() => {
        hero.style.setProperty('--hero-rx', (x * 12).toFixed(2) + 'deg');
        hero.style.setProperty('--hero-ry', (-y * 10).toFixed(2) + 'deg');
        frame = 0;
      });
    }, { passive: true });
    hero.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame); frame = 0;
      hero.style.setProperty('--hero-rx', '0deg');
      hero.style.setProperty('--hero-ry', '0deg');
    });
    document.addEventListener('craftush:motion', () => {
      if (root.dataset.motion === 'paused') {
        cancelAnimationFrame(frame); frame = 0;
        hero.style.setProperty('--hero-rx', '0deg');
        hero.style.setProperty('--hero-ry', '0deg');
      }
    });
  }

  const syncFooter = () => {
    document.querySelectorAll('[data-tool-link]').forEach(link => {
      const card = document.querySelector('.slide[data-id="' + link.dataset.toolLink + '"]');
      link.hidden = !card || !!card.querySelector('.open')?.hidden;
      const title = card?.querySelector('.title');
      if (title) link.textContent = title.textContent;
    });
  };
  document.addEventListener('craftush:tools-config', syncFooter);
  syncFooter();
  const year = document.getElementById('creditYear');
  if (year) year.textContent = String(new Date().getFullYear());
})();

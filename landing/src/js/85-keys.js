/* 85-keys.js (figures): page keys (brief §9) and the keys sheet (§3.14, P14). */
{
  const IDS = ['top', 'why', 'inherit', 'how', 'map', 'recall', 'away', 'local', 'notes', 'get'];
  const root = document.documentElement, $ = (s) => document.querySelector(s);
  let sheet = null, opener = null, aimY = 0, aimT = -1e9;
  const vis = (el) => { // px of el in view (vertically)
    const r = el?.getBoundingClientRect();
    return r ? Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) : 0;
  };
  const held = new Map(); // key -> the keycap shown pressed while that key is down (P5)
  const press = (b, key) => {
    const k = b?.querySelector('.kbd');
    if (!k) return;
    k.classList.add('is-pressed');
    held.set(key, k);
  };
  const release = (key) => {
    for (const [x, k] of held) if (key == null || x === key) { k.classList.remove('is-pressed'); held.delete(x); }
  };
  // The letter a key event means: e.key, or the physical key on non-Latin layouts.
  const letter = (e) => (/^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code || '') ? e.code[3].toLowerCase() : '');
  document.addEventListener('keyup', (e) => release(letter(e)));
  addEventListener('blur', () => release());
  const aim = (el) => Math.max(0, Math.min(root.scrollHeight - innerHeight,
    Math.round(el.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0))));
  const goTo = (el) => {
    aimY = aim(el);
    aimT = performance.now();
    el.scrollIntoView({ behavior: M.reduced ? 'auto' : 'smooth' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  };

  const isOpen = () => !!sheet && !sheet.hidden;
  const toggle = (on = !isOpen(), silent) => {
    if (!sheet || on === isOpen()) return;
    const back = !on && !silent && sheet.contains(document.activeElement);
    if (on) { M.fnClose?.(); opener = document.activeElement; }
    sheet.hidden = !on;
    if (on) sheet.focus({ preventScroll: true }); else if (back) opener?.focus({ preventScroll: true });
    for (const b of M.$$('[data-keys-open]')) b.setAttribute('aria-expanded', on);
  };
  M.keys = { isOpen, toggle };
  M.onBoot(() => {
    sheet = document.getElementById('keys');
    for (const b of M.$$('[data-keys-open]')) { b.setAttribute('aria-controls', 'keys'); b.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-keys-open]')) toggle();
    else if (e.target.closest?.('[data-keys-close]')) toggle(false);
  });

  // Ignored in inputs and with Ctrl/Alt/Meta; Shift only for ?.
  document.addEventListener('keydown', (e) => {
    const t = e.target, key = e.key;
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey
      || t?.isContentEditable || t?.closest?.('input,textarea,select')) return;
    if (key === 'Escape') {
      if (isOpen()) { e.preventDefault(); e.stopPropagation(); toggle(false); }
      return;
    }
    if (key === '?') { e.preventDefault(); return toggle(); }
    const k = letter(e);
    if (e.shiftKey || (e.repeat && k !== 'j' && k !== 'k')) return;
    if (k === 'd') {
      const a = $('.nav [aria-keyshortcuts="D"]') || $('[aria-keyshortcuts="D"]');
      if (!a) return;
      press(a, 'd');
      a.click();
    } else if (k === 'b') { // only while the hero's window is >= 30 % in view
      if (!M.hero?.isVisible()) return;
      press($('[aria-keyshortcuts="B"]'), 'b');
      M.hero.branchNext();
    } else if (k === 'm') {
      const m = document.getElementById('map');
      if (!m) return;
      goTo(m);
    } else if (k === 'j' || k === 'k') { // repeats during a smooth scroll count from its target
      const y0 = performance.now() - aimT < 900 ? aimY : scrollY, list = IDS.map((id) => document.getElementById(id)).filter(Boolean);
      const hit = k === 'j' ? list.find((el) => aim(el) > y0 + 2) : list.reverse().find((el) => aim(el) < y0 - 2);
      if (hit) goTo(hit);
    } else if (k === 'r') { // the take showing the most of itself on screen
      let best = null, v = 0;
      for (const tk of M.list) { const s = vis(tk.root); if (s > v) { v = s; best = tk; } }
      if (!best) return;
      best.replay();
    } else return;
    e.preventDefault();
  }, true);
}

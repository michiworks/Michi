/* 80-footnotes.js (figures): footnote cards for a.fn (brief §3.13, §7.6, §9, P10-P12). */
{
  let cur = null, pin = false, tIn = 0, tOut = 0, quiet = false;
  const card = (f) => document.getElementById(f.getAttribute('aria-controls'));
  const fnOf = (t) => t?.closest?.('a.fn[aria-controls]');
  const inside = (t) => !!cur && (cur.contains(t) || card(cur).contains(t));
  const place = (f) => { // below the phrase from its start, 8 gap; above if no room; 8 inside the viewport
    const c = card(f), r = f.getBoundingClientRect(), h = c.offsetHeight;
    let y = r.bottom + 8;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - 8 - h);
    c.style.left = Math.min(Math.max(8, r.left), Math.max(8, document.documentElement.clientWidth - c.offsetWidth - 8)) + scrollX + 'px';
    c.style.top = y + scrollY + 'px';
  };
  const close = () => {
    clearTimeout(tIn);
    clearTimeout(tOut);
    if (!cur) return;
    card(cur).classList.add('is-off');
    cur.setAttribute('aria-expanded', 'false');
    cur = null;
    pin = false;
  };
  const open = (f) => {
    clearTimeout(tIn);
    clearTimeout(tOut);
    if (f === cur) return;
    close();
    M.keys?.toggle(false, true);
    place(f);
    card(f).classList.remove('is-off');
    f.setAttribute('aria-expanded', 'true');
    cur = f;
  };
  const later = () => {
    clearTimeout(tOut);
    tOut = setTimeout(() => {
      if (cur && !pin && !cur.matches(':hover,:focus') && !card(cur).matches(':hover,:focus-within')) close();
    }, 120);
  };
  M.fnClose = close;
  // P12 after the scroll settles: at least 8 frames, the last 4 still.
  const flash = (el) => {
    let y = -1, n = 0, still = 0;
    const t = () => {
      still = scrollY === y ? still + 1 : 0;
      y = scrollY;
      if (++n < 120 && (n < 9 || still < 4)) return requestAnimationFrame(t);
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
      clearTimeout(el._fl);
      el._fl = setTimeout(() => el.classList.remove('is-flash'), 700);
    };
    requestAnimationFrame(t);
  };
  const arrive = () => {
    const n = /^#note-[\w-]+$/.test(location.hash) && document.getElementById(location.hash.slice(1));
    if (n) flash(n);
  };

  M.onBoot(() => {
    const tpl = document.getElementById('fn-cards');
    for (const f of M.$$('a.fn[href^="#note-"]')) {
      const id = f.getAttribute('href').slice(1);
      let c = document.querySelector('body > [data-fn="' + id + '"]');
      if (!c && (c = tpl?.content.querySelector('[data-fn="' + id + '"]'))) document.body.appendChild(c = c.cloneNode(true));
      if (!c) continue;
      f.setAttribute('role', 'button');
      f.setAttribute('aria-expanded', 'false');
      f.setAttribute('aria-controls', c.id);
    }
    arrive();
  });

  const on = (t, fn, o) => document.addEventListener(t, fn, o);
  on('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const f = fnOf(e.target);
    if (f && f !== cur) { clearTimeout(tIn); tIn = setTimeout(() => open(f), 80); } else if (inside(e.target)) clearTimeout(tOut);
  });
  on('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    if (fnOf(e.target)) clearTimeout(tIn);
    if (cur) later();
  });
  on('focusin', (e) => { const f = fnOf(e.target); if (f && !quiet) open(f); });
  // Only focus leaving the phrase or its card counts: out of both closes it
  // (unpinned) unless the pointer holds it; inside (phrase <-> card) waits.
  on('focusout', (e) => {
    if (!cur || !inside(e.target)) return;
    const to = e.relatedTarget;
    if (to && !inside(to)) { pin = false; if (!cur.matches(':hover') && !card(cur).matches(':hover')) close(); } else later();
  });
  on('pointerdown', (e) => { if (cur && !inside(e.target)) close(); }, true);
  on('click', (e) => {
    const f = fnOf(e.target), b = e.target.closest?.('.fn-card button');
    const n = b && document.getElementById(b.parentNode.getAttribute('data-fn'));
    if (b) close();
    if (n) { // jump to the note and flash it
      n.scrollIntoView({ behavior: M.reduced ? 'auto' : 'smooth' });
      n.setAttribute('tabindex', '-1');
      n.focus({ preventScroll: true });
      flash(n);
    }
    if (!f || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // modified click: a plain link
    e.preventDefault();
    if (f === cur && pin) close(); else { open(f); pin = true; }
  });
  on('keydown', (e) => {
    const f = fnOf(e.target), k = e.key;
    if (f && (k === 'Enter' || k === ' ')) {
      e.preventDefault();
      open(f);
      pin = true;
      card(f).querySelector('button').focus();
    } else if (cur && k === 'Tab' && card(cur).contains(e.target)) {
      // The card sits at the end of <body>: Tab out continues after its phrase.
      e.preventDefault();
      const g = cur;
      if (e.shiftKey) { pin = false; return g.focus(); } // back on the phrase: unpinned, so leaving it closes the card
      const a = M.$$('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])').filter((x) =>
        !x.closest('.fn-card,[hidden]') && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden');
      close();
      (a[a.indexOf(g) + 1] || g).focus();
    } else if (cur && k === 'Escape' && !M.keys?.isOpen()) {
      const g = cur, back = inside(document.activeElement);
      close();
      if (back) { quiet = true; g.focus(); quiet = false; }
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  addEventListener('resize', () => { if (cur) place(cur); }, { passive: true });
  addEventListener('hashchange', arrive);
}

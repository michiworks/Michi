/* 20-hero.js (hero): take 1, the visitor branch and M.hero (brief §5.5, §5.6,
   §5.12). Layout and tweens are in 40-hero.css; ops only set classes and the
   morph geometry. */
{
  const VQ = ['a', 'f']; // visitor phrases, in B order
  const LIVE = { a: 'Branched “11 developer accounts” into a new pane.', f: 'Branched “first-time deployment” into a new pane.' };
  let tk = null, run = null, used = {}, open = null, pin = false, timer = 0;
  const compact = () => !M.mq('(min-width: 1024px)');
  const sel = (k, a) => '[data-' + a + '="' + k + '"]';

  // Design-px boxes in the window frame, the containing block of pops and cards.
  const geo = (root) => {
    const f = root.querySelector('.mk-window'), fr = f.getBoundingClientRect(), cv = root.querySelector('.mk-canvas');
    const k = cv.getBoundingClientRect().width / cv.offsetWidth || 1;
    const at = (el) => {
      const b = el.getBoundingClientRect();
      return { l: (b.left - fr.left) / k - f.clientLeft, t: (b.top - fr.top) / k - f.clientTop,
        r: (b.right - fr.left) / k - f.clientLeft, b: (b.bottom - fr.top) / k - f.clientTop };
    };
    return { at, W: f.clientWidth, H: f.clientHeight };
  };

  // SelectionActions placePopup for the bar and the composer: 16 above the
  // phrase unless only below fits, centred on it, 8 inside the window, 12
  // inside its pane (the whole strip while the main pane is alone). Where it
  // fits neither (short compact panes) it goes below rather than over the
  // phrase. Then the FLIP start: surface and pinned, clipped content at the bar.
  const place = (root, pop, hl) => {
    const g = geo(root), s = g.at(hl), pane = hl.closest('.mk-pane'), strip = pane.parentElement, st = pop.style;
    const p = g.at(strip.classList.contains('hero-t0') && !compact() ? strip : pane);
    const floor = g.at(pane.querySelector('.mk-composer')).t, cx = (s.l + s.r) / 2;
    st.width = Math.min(340, p.r - p.l - 24) + 'px';
    const bar = pop.querySelector('.hero-barc'), bw = bar.offsetWidth + 2, bh = bar.offsetHeight + 2;
    const cw = pop.offsetWidth, ch = pop.offsetHeight;
    const fit = (w, h) => {
      const below = s.t - 8 < h + 16 && (floor - s.b - 8 >= h + 16 || s.b + 24 + h <= g.H);
      return { below, l: Math.max(p.l + 12, Math.min(cx - w / 2, p.r - 12 - w)),
        t: Math.max(8, Math.min(below ? s.b + 16 : s.t - 16 - h, g.H - h - 8)) };
    };
    const B = fit(bw, bh), C = fit(cw, ch), x = B.l - C.l, y = B.t - C.t;
    st.left = C.l + 'px';
    st.top = C.t + 'px';
    for (const [n, v] of [['--bx', x + 'px'], ['--by', y + 'px'], ['--sx', bw / cw], ['--sy', bh / ch],
      ['--cr', cw - bw + 'px'], ['--cb', ch - bh + 'px'], ['--ey', B.below ? '-4px' : '4px']]) st.setProperty(n, v);
    st.transformOrigin = x + bw / 2 + 'px ' + (y + (B.below ? 0 : bh)) + 'px';
  };

  // Branch cards (BranchQuoteUnderline): below the phrase from its left edge,
  // 6 apart, above when there is no room; one open at a time.
  const hideCard = (root) => {
    clearTimeout(timer);
    if (!open) return;
    root.querySelector(sel(open, 'card')).classList.add('is-off');
    root.querySelector(sel(open, 'hp')).classList.remove('is-open');
    open = null;
    pin = false;
  };
  const showCard = (root, k, pinned) => {
    clearTimeout(timer);
    if (open !== k) {
      hideCard(root);
      const cd = root.querySelector(sel(k, 'card')), a = root.querySelector(sel(k, 'hp'));
      // The phrase's text box: on touch the anchor carries hit-area padding.
      const g = geo(root), s = g.at(a.firstElementChild), w = cd.offsetWidth, h = cd.offsetHeight;
      cd.style.left = Math.max(8, Math.min(s.l, g.W - w - 8)) + 'px';
      cd.style.top = (s.b + 6 + h > g.H ? Math.max(8, s.t - h - 6) : s.b + 6) + 'px';
      cd.classList.remove('is-off');
      a.classList.add('is-open');
      open = k;
    }
    pin = pin || !!pinned;
  };
  // Touch: unused phrases keep the 8 % rest tint after the hold.
  const rest = () => {
    const on = !!tk && M.touch() && tk.state === 'held';
    if (tk) for (const k of VQ) tk.root.querySelector(sel(k, 'hp') + ' .mk-hot').classList.toggle('is-rest', on && !used[k]);
  };
  // At rest the leads must be on screen. A compact pane is too short to keep
  // the first answer in view, so bring its list back to it (220, pane) and
  // drop the tail fit still pending (finish() flushes it after the steps).
  // Layout maths as in the engine's fit (top-anchored list, translate <= 0),
  // so a move in flight cannot skew it.
  const peek = (root, now) => {
    const list = root.querySelector('.hero-main [data-follow]'), h = list.offsetHeight, vh = list.parentElement.clientHeight;
    const lr = list.getBoundingClientRect(), k = lr.height / h || 1;
    const off = (el, e) => (el.getBoundingClientRect()[e || 'top'] - lr.top) / k;
    const tail = M.tailOf(list), fit = Math.min(0, vh - 16 - (tail ? off(tail, 'bottom') : h));
    if (fit + off(root.querySelector(sel('a', 'hp') + ' .mk-hl')) >= 4) return;
    M.dropTails(list);
    M.unfollow(list); // placed by hand: the engine's anchor must not pull it back to the tail
    list._ty = Math.max(Math.min(0, vh - h), Math.min(0, 12 - off(list.querySelector('ol').previousElementSibling)));
    if (now) list.style.transition = 'none';
    list.style.transform = 'translateY(' + list._ty + 'px)';
    if (now) { M.flush(list); list.style.transition = ''; }
  };

  M.op('hero:select', (c, hl, ms) => {
    const el = c.q(hl);
    el.style.setProperty('--hl-ms', (ms || 220) + 'ms');
    el.classList.add('is-sel');
  });
  M.op('hero:bar', (c, pop, hl) => {
    const p = c.q(pop);
    place(c.root, p, c.q(hl));
    M.flush(p);
    p.classList.remove('is-off');
  });
  M.op('hero:morph', (c, pop, hl) => {
    c.q(pop).classList.add('is-comp');
    c.q(hl).classList.replace('is-sel', 'is-mark');
  });
  M.op('hero:close', (c, pop) => c.q(pop).classList.add('is-gone'));
  // The mark becomes the underline. Not show/cls: those report a tail, and an
  // instant finish (steps, a second branch, scrolling away) would then scroll
  // the thread to the phrase.
  M.op('hero:ul', (c, k) => {
    const a = c.q(sel(k, 'hp'));
    a.firstElementChild.classList.remove('is-mark');
    a.classList.remove('is-off');
  });
  M.op('hero:prep', (c, k) => {
    hideCard(c.root);
    const a = c.q(sel(k, 'hp'));
    a.classList.add('is-used');
    a.querySelector('.mk-hot').classList.remove('is-rest');
    M.hideText(c.q(sel(k, 'pop') + ' .hero-q'));
    M.hideText(c.q(sel(k, 'card') + ' .mk-bcard-r'));
  });
  // A new off-screen branch pins a bookmark; a second stacks below the first.
  M.op('hero:bm', (c, k) => {
    const w = c.q(sel(k, 'bm')), el = w.firstElementChild;
    const o = c.qa('[data-bm]').find((x) => x !== w && !x.firstElementChild.classList.contains('is-off'));
    if (o) { o.classList.add('is-up'); w.classList.add('is-dn'); }
    M.lock(el);
    el.classList.add('is-working');
    el.classList.remove('is-off');
  });
  M.op('hero:card', (c, k) => showCard(c.root, k, true));
  M.op('hero:live', (c, k) => { const el = c.root.querySelector('[data-hero-live]'); if (el) el.textContent = LIVE[k]; });

  // The visitor branch (V1-V3): the take's own sequence, compressed.
  const vsteps = (k) => {
    const P = sel(k, 'pop'), HL = sel(k, 'hp') + ' .mk-hl', C = sel(k, 'card'), BM = sel(k, 'bm');
    const R = sel(k, 'sr'), RL = R + ' .mk-srow-rail', ST = C + ' .hero-st', TY = C + ' .mk-bcard-typing';
    const n = tk.root.querySelectorAll(P + ' .hero-q .c').length, w = tk.root.querySelectorAll(C + ' .mk-bcard-r .w').length;
    const T = 700 + n * 14, F = T + 290, Q = F + 1320, E = Q + w * 40 + 360;
    return [
      [0, 'hero:prep', k],
      // Running: the static amber LoaderCircle of BranchStatusLabel.
      [0, 'pick', ST, 0], [0, 'cls', TY, '-is-off +is-live'],
      [0, 'pick', BM + ' .mk-arrival-status', 0],
      [0, 'hero:select', HL, 160],
      [200, 'hero:bar', P, HL],
      [480, 'press', P + ' .mk-selbar-btn:first-child', { down: 60 }],
      [540, 'hero:morph', P, HL],
      [700, 'type', P + ' .hero-q', { rate: 14, jitter: 3, space: 8, stop: 40, comma: 20, until: T, keepCaret: true }],
      [T + 90, 'press', P + ' .is-submit'],
      [T + 210, 'hero:close', P],
      [F, 'hero:bm', k],
      [F, 'row', R], [F, 'fx', R + ' .hero-wash', 'hero-washing', 680], [F, 'cls', RL, '-hero-rail0'],
      [F, 'hero:ul', k], [F, 'hero:live', k],
      [F + 120, 'hero:card', k],
      [F + 260, 'loop', RL, 'is-live'],
      [Q, 'cls', TY, '+is-off -is-live'],
      [Q, 'stream', C + ' .mk-bcard-r', { rate: 40, jitter: 6, sentence: 60, until: Q + w * 40 }],
      [E, 'pick', ST, 1],
      [E, 'pick', BM + ' .mk-arrival-status', 1], [E, 'cls', BM + ' .mk-arrival', '-is-working'],
      [E, 'loop', RL, 'is-live', false],
    ];
  };

  const POP = '[data-pop="t"]', HL = '[data-hp="t"] .mk-hl', IN = '.hero-main .mk-input', SM = '.hero-main .mk-send';
  const BP = '.hero-branch', SB = BP + ' .mk-send', RT = '[data-sr="t"]', RR = RT + ' .mk-srow-rail';
  // Once per session per palette: the head script reads the same key.
  const PAL = document.documentElement.dataset.palette;
  tk = M.take({
    name: 'hero',
    hero: true,
    session: 'michi:hero' + (PAL ? ':' + PAL : ''),
    catchUp: 600,
    seed: 7,
    scrollGuard: () => (compact() ? null : { px: 120, beforeMs: 2760 }),
    steps: [
      [700, 'hero:select', HL, 220],
      [700, 'cls', IN, '-has-caret'],
      [960, 'hero:bar', POP, HL],
      [1240, 'press', POP + ' .mk-selbar-btn:first-child', { down: 60 }],
      [1300, 'hero:morph', POP, HL],
      [1500, 'type', POP + ' .hero-q', { until: 2470, keepCaret: true }],
      [2560, 'press', POP + ' .is-submit'],
      [2680, 'hero:close', POP],
      // The fork: CSS moves the panes (wide/medium) or draws and reveals (compact).
      [2760, 'cls', '.hero-strip', '-hero-t0'],
      [2760, 'fx', BP + ' .mk-head', 'fx-flash', 600],
      [2760, 'row', RT], [2760, 'fx', RT + ' .hero-wash', 'hero-washing', 680], [2760, 'cls', RR, '-hero-rail0'],
      [2980, 'hero:ul', 't'],
      [3000, 'show', BP + ' .mk-label'], [3000, 'show', BP + ' .mk-thought'],
      [3000, 'loop', BP, 'is-streaming'], [3000, 'cls', SB, '-is-empty +is-stop'],
      [3000, 'type', IN + ' .hero-sent', { until: 3800, keepCaret: true }],
      [3000, 'cls', SM, '-is-empty'],
      [3020, 'fx', RR, 'fx-pulse2', 1200],
      // The app shows no Working row while a tool runs (StreamActivityIndicator).
      [3250, 'tool', BP + ' .mk-tool', 'run'],
      [3880, 'press', SM],
      [3900, 'tool', BP + ' .mk-tool', 'done'],
      [3920, 'clear', IN, { caret: false }],
      [3920, 'cls', SM, '+is-stop'],
      [3920, 'show', '.hero-u2'],
      [3920, 'loop', '.hero-main', 'is-streaming'], [3920, 'loop', '.hero-r0', 'is-live'],
      [4000, 'stream', BP + ' .hero-ans', { rate: 62, jitter: 10, until: 5700 }],
      [4150, 'show', '.hero-a2 .mk-label'], [4150, 'show', '.hero-a2 .mk-thought'],
      [4220, 'loop', RR, 'is-live'],
      [4300, 'stream', '.hero-a2 .mk-prose', { rate: 44, jitter: 8, until: 6150 }],
      [5700, 'loop', BP, 'is-streaming', false], [5700, 'loop', RR, 'is-live', false],
      [5700, 'cls', SB, '-is-stop +is-empty'],
      [6150, 'loop', '.hero-main', 'is-streaming', false], [6150, 'loop', '.hero-r0', 'is-live', false],
      [6150, 'cls', SM, '-is-stop +is-empty'],
      [6400, 'hold'],
      [6400, 'call', (c) => peek(c.root, c.instant)],
      [6400, 'fx', '.hero-main .mk-hot', 'fx-invite', 1200],
    ],
    reset(t) {
      document.documentElement.setAttribute('data-hero-ready', ''); // before the engine measures tA tails
      run = null;
      used = {};
      hideCard(t.root);
      t.root.querySelector('.take-bar').removeAttribute('data-hint');
      t.root.querySelector('[data-hero-live]').textContent = '';
    },
    onHold: rest,
    // The engine refits idle tails (boot at tB, fonts, resizes, breakpoints):
    // at rest the main list goes back to the leads.
    onFit(t) { if (t.state === 'held') peek(t.root, true); },
  });

  const H = M.hero = {
    // B, CTA 2 or a click on a phrase: finish the take, then branch (§5.6).
    branch(k) {
      if (!tk || !VQ.includes(k) || used[k]) return;
      if (tk.state === 'armed' || tk.busy()) tk.finish();
      run?.finish();
      used[k] = true;
      if (VQ.every((x) => used[x])) tk.root.querySelector('.take-bar').setAttribute('data-hint', 'alt');
      run = M.run(tk.root, vsteps(k), { seed: 31 + VQ.indexOf(k), exclusive: true });
    },
    branchNext() {
      const k = VQ.find((x) => !used[x]);
      if (k) H.branch(k); else H.replay();
    },
    replay() { tk?.replay(); },
    // B acts only while the window is at least 30 % visible (brief §9).
    isVisible() {
      const r = tk?.observeEl?.getBoundingClientRect();
      return !!r && Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) >= 0.3 * Math.min(r.height, innerHeight);
    },
  };

  M.onBoot(() => {
    if (!tk) return;
    const root = tk.root, cv = root.querySelector('.mk-canvas');
    const hp = (e) => e.target.closest?.('[data-hp]');
    cv.addEventListener('click', (e) => {
      const a = hp(e);
      if (!a) return;
      if (!a.classList.contains('is-off')) showCard(root, a.dataset.hp, true);
      else H.branch(a.dataset.hp);
    });
    cv.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const a = hp(e);
      if (e.target.closest('[data-card]')) clearTimeout(timer);
      else if (a && !a.classList.contains('is-off')) showCard(root, a.dataset.hp, false);
    });
    cv.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'touch' || !open || pin || e.relatedTarget?.closest?.(sel(open, 'card') + ',' + sel(open, 'hp'))) return;
      clearTimeout(timer);
      timer = setTimeout(() => hideCard(root), 100);
    });
    document.addEventListener('pointerdown', (e) => { if (open && !e.target.closest?.('[data-card],[data-hp]')) hideCard(root); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCard(root); });
    for (const b of document.querySelectorAll('[data-hero-branch]')) b.addEventListener('click', () => H.branchNext());
    M.on('bp', () => hideCard(root)); // the engine refits the lists, then onFit peeks
    rest();
  });
}

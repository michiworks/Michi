/* 50-map.js (map): take 3 (brief §5.8) and the Map after its hold (G11).
   Hover/keyboard focus lights a card's way back (look); click, Enter or tap
   pins it and updates the breadcrumb (go); Esc, empty ground or a second tap
   unpins. Lineage as pages/Map.tsx. Markup and attributes: html/50-map.html. */
{
  // Card n: [chain, ringed merge sources, lit edge]. HOME: where the take leaves you.
  const LIN = [['0', '', ''], ['1 0', '', '1'], ['2 0', '', '2'], ['3 0', '', '3'], ['4', '2 3', 'm']];
  const HOME = 4;

  const light = (root, n) => { // n == null clears
    const L = LIN[n], e = L && L[2], has = (k, i) => !!L && L[k].split(' ').includes(i);
    for (const s of root.querySelectorAll('.map-s')) {
      const i = s.dataset.n, cl = s.querySelector('.mk-mcard').classList, a = has(0, i), r = has(1, i);
      cl.toggle('is-anc', a);
      cl.toggle('is-source', r);
      cl.toggle('is-dim', !!L && !a && !r);
    }
    for (const el of root.querySelectorAll('[data-v]')) {
      const v = !!e && el.dataset.v.split(' ').includes(e), t = v && (el.dataset.t || e) === e;
      if (t && el.classList.contains('map-e') && el.nextElementSibling) { // shared trunk: lit edge paints last
        el.parentNode.appendChild(el);
        void getComputedStyle(el).stroke; // keep its colour tween
      }
      el.classList.toggle('is-lit', t);
      el.classList.toggle('is-pass', v && !t);
      el.classList.toggle('is-dim', !!L && !v);
    }
  };

  M.op('edge', (c, id) => { for (const el of c.qa('[data-e="' + id + '"]')) el.classList.remove('is-off'); });
  M.op('rise', (c, n) => { for (const el of c.qa('.map-s' + n + ' :is(.e-rise, .mk-heat)')) el.classList.remove('is-off'); });
  M.op('lineage', (c, n) => light(c.root, n));
  M.op('outline', (c, n) => { // n: add that card; none: clear all
    for (const b of c.qa('.map-box')) b.classList.toggle('is-picked', n != null && (b.classList.contains('is-picked') || +b.parentNode.dataset.n === n));
  });
  M.op('mapbar', (c, on) => c.op(on ? 'show' : 'hide', '.mk-mapbar'));
  M.op('merge', (c, id) => { c.op('edge', id); c.op('loop', '[data-flow="' + id + '"]', 'is-flow'); });

  // Cards rise at 60 % of their edge's 600 ms ease-out draw (+255 ms).
  const S4 = '.map-s4 ';
  const steps = [
    [200, 'edge', '1'], [320, 'edge', '2'], [440, 'edge', '3'],
    [455, 'rise', 1], [575, 'rise', 2], [695, 'rise', 3],
    [1500, 'lineage', 2], [2300, 'lineage'],
    [2600, 'outline', 3], [2900, 'outline', 2], [3000, 'mapbar', true],
    [3700, 'press', '.map-merge'], [3850, 'mapbar', false], [3850, 'outline'],
    [3900, 'merge', 'm1'], [3980, 'merge', 'm2'],
    [4235, 'rise', 4], [4235, 'cls', S4 + '.mk-heat', '+is-streaming'], [4235, 'pick', S4 + '.xf', 0],
    [4235, 'loop', S4 + '.mk-mlive', 'is-live'], [4235, 'fx', S4 + '.mk-mcard', 'fx-breathe', 2400],
    [5800, 'show', S4 + '.mk-msum'], [5800, 'pick', S4 + '.xf', 1], [5800, 'loop', S4 + '.mk-mlive', 'is-live', false],
    [5800, 'cls', S4 + '.mk-heat', '-is-streaming'], [5800, 'loop', '[data-flow]', 'is-flow', false],
    [6400, 'lineage', HOME], [6400, 'hold'],
  ];

  // Lit: hover ?? keyboard focus ?? pin ?? HOME. The breadcrumb (button data-crumb) follows the pin.
  const control = (root) => {
    const crumb = root.querySelector('.map-crumb-t'), home = crumb.textContent, hits = Array.from(root.querySelectorAll('.map-hit'));
    let live = false, hover = null, focus = null, pin = null, kind = '';
    const hit = (e) => e.target.closest?.('.map-hit');
    const toHit = (e) => !!e.relatedTarget?.closest?.('.map-hit');
    const render = () => {
      const here = pin ?? HOME, t = pin == null ? home : hits[pin].dataset.crumb;
      light(root, hover ?? focus ?? here);
      for (const b of hits) {
        if (+b.dataset.n === here) b.setAttribute('aria-current', 'location');
        else b.removeAttribute('aria-current');
      }
      if (crumb.textContent !== t) crumb.textContent = t;
    };
    root.addEventListener('pointerdown', (e) => { kind = e.pointerType; });
    root.addEventListener('pointerover', (e) => {
      const b = hit(e);
      if (live && b && e.pointerType !== 'touch') { hover = +b.dataset.n; render(); }
    });
    root.addEventListener('pointerout', (e) => { if (live && hit(e) && !toHit(e)) { hover = null; render(); } });
    root.addEventListener('focusin', (e) => {
      const b = hit(e);
      if (live && b && b.matches(':focus-visible')) { focus = +b.dataset.n; render(); }
    });
    root.addEventListener('focusout', (e) => { if (live && hit(e) && !toHit(e)) { focus = null; render(); } });
    root.addEventListener('click', (e) => {
      if (!live || !e.target.closest('.map-band')) return;
      const b = hit(e), n = b ? +b.dataset.n : null;
      const tap = e.pointerType ? e.pointerType === 'touch' : e.detail > 0 && kind === 'touch';
      pin = b && !(tap && pin === n) ? n : null;
      render();
    });
    document.addEventListener('keydown', (e) => {
      if (live && pin != null && e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) { pin = null; render(); }
    });
    return {
      on() { live = true; hover = focus = pin = null; for (const b of hits) b.hidden = false; render(); },
      off() {
        live = false; hover = focus = pin = null;
        for (const b of hits) { b.hidden = true; b.removeAttribute('aria-current'); }
        crumb.textContent = home;
      },
    };
  };

  let ctl = null;
  const tk = M.take({
    name: 'map',
    seed: 3,
    cutMerge: 500, // reduced-motion cuts: tree, trace, release, picks, merge, RCA, settle, hold
    steps,
    reset(t) { ctl?.off(); light(t.root, null); },
    onHold() { ctl?.on(); },
  });
  if (tk) {
    ctl = control(tk.root);
    M.onBoot(() => { if (tk.state === 'held') ctl.on(); });
  }
}

/* 62-away.js (away): #away, ADDENDUM-AWAY.md. One pass of four scenes in one window
   (the frame never fades; its main area swaps), as #how's tablist: a picked tab plays its
   scene alone and holds (reduced motion: its final frame). */
{
  const LEN = [0, 6000, 7400, 6000, 5800]; // each scene, ms
  const AT = [0, 0, 6300, 14000, 20300]; // scene starts in the pass
  const END = 26300;
  const AREA = [null, 'pages', 'conv', 'sched', 'conv']; // the rail item each scene sits in
  const SA = '.away-sa', SB = '.away-sb';
  const ROWS = [null, [
    // 1. Pages: the Meta agent reads a finished conversation and adds a block with its source.
    [0, 'away-row', 1], [0, 'away-area', 1],
    [500, 'pick', '.away-st-ic', 1], [500, 'loop', '.away-st-spin', 'is-live'], [500, 'pick', '.away-st-t', 1],
    [1500, 'row', '.away-cause'], [1500, 'show', '.away-cin', { stagger: 40 }],
    [2300, 'loop', '.away-st-spin', 'is-live', false], [2300, 'pick', '.away-st-ic', 0], [2300, 'pick', '.away-st-t', 2],
    [2300, 'text', '.away-upd', 'Updated now'],
    [3000, 'cls', '.away-cause .away-item', '+is-hover'], [3000, 'show', '.away-src'],
    [3500, 'press', '.away-src', { down: 60 }], [3560, 'show', '.away-pop'],
    [6000, 'away-row', 1, true],
  ], [
    // 2. Memory: save a note in Tokyo deployment, then a new chat on Codex already knows it.
    [0, 'away-row', 2], [0, 'away-area', 2], [0, 'swap', '.away-s1', '.away-s2'],
    [200, 'type', '.away-d1', { rate: 16, jitter: 4, space: 10, until: 1300 }], [200, 'cls', SA, '-is-empty'],
    [1350, 'press', SA], [1350, 'clear', '.away-d1'], [1350, 'cls', SA, '+is-stop'], [1350, 'show', '.away-u1'],
    [1400, 'loop', '.away-m1', 'is-streaming'],
    [1550, 'show', '.away-l1'], [1550, 'group', '.away-g1', 'run'],
    [1600, 'tool', '.away-r1', 'run'], [1850, 'tool', '.away-r1', 'done'], [1850, 'text', '.away-gm1', '1/2'],
    [1900, 'tool', '.away-r2', 'run'], [2150, 'tool', '.away-r2', 'done'],
    [2150, 'group', '.away-g1', 'done'], [2150, 'text', '.away-gm1', '0.2s'],
    [2250, 'stream', '.away-p1', { rate: 45, until: 2600 }],
    [2650, 'loop', '.away-m1', 'is-streaming', false], [2650, 'cls', SA, '-is-stop +is-empty'],
    [2800, 'show', '.away-toast'],
    [4000, 'hide', '.away-toast'], [4000, 'swap', '.away-m1', '.away-m2'],
    [4300, 'type', '.away-d2', { rate: 24, until: 4800 }], [4300, 'cls', SB, '-is-empty'],
    [4900, 'press', SB], [4900, 'clear', '.away-d2'], [4900, 'cls', SB, '+is-stop'], [4900, 'show', '.away-u2'],
    [4900, 'text', '.away-t2', 'Draft the Tokyo fix.'],
    [5000, 'loop', '.away-m2', 'is-streaming'],
    [5150, 'show', '.away-l2'],
    [5250, 'stream', '.away-p2', { rate: 40, jitter: 8, until: 6900 }],
    [6950, 'loop', '.away-m2', 'is-streaming', false], [6950, 'cls', SB, '-is-stop +is-empty'],
    [7400, 'away-row', 2, true],
  ], [
    // 3. Scheduled: the weekday check runs, settles, and the OS notification brings its summary.
    [0, 'away-row', 3], [0, 'away-area', 3], [0, 'swap', '.away-s2', '.away-s3'],
    [600, 'pick', '.away-j-ic', 1], [600, 'loop', '.away-j-spin', 'spin'], [600, 'pick', '.away-j-next', 1],
    [600, 'pick', '.away-j-st', 1], [600, 'loop', '.away-j-dot', 'is-live'], [600, 'pick', '.away-j-when', 1],
    [600, 'pick', '.away-j-run', 1], [600, 'show', '.away-rdot'],
    [3300, 'loop', '.away-j-spin', 'spin', false], [3300, 'pick', '.away-j-ic', 0], [3300, 'pick', '.away-j-next', 2],
    [3300, 'loop', '.away-j-dot', 'is-live', false], [3300, 'pick', '.away-j-st', 0],
    [3300, 'pick', '.away-j-run', 0], [3300, 'hide', '.away-rdot'],
    [3700, 'show', '.away-note'],
    [6000, 'away-row', 3, true],
  ], [
    // 4. Phone: the desktop dims, the phone opens the same thread and switches to a finished branch.
    [0, 'away-row', 4], [0, 'away-area', 4], [0, 'swap', '.away-s3', '.away-s4'],
    [700, 'cls', '.away-win', '+is-dim'],
    [900, 'show', '.away-phone'],
    [2000, 'cls', '.away-tap1', '+is-tap'], [2160, 'cls', '.away-tap1', '-is-tap'], [2160, 'show', '.away-sw'],
    [3300, 'cls', '.away-sw-r3', '+is-tap'],
    [3460, 'hide', '.away-sw'], [3460, 'cls', '.away-sw-r3', '-is-tap'], [3460, 'text', '.away-ph-t', 'Identity check'],
    [3460, 'swap', '.away-ph-a', '.away-ph-b'], [3460, 'pick', '.away-d-bs1', 1],
    [5800, 'away-row', 4, true],
  ]];
  const shift = (list, dt) => list.map((s) => [s[0] + dt].concat(s.slice(1)));
  const bars = (root) => root.querySelectorAll('.away-prog');

  // Selection: the active title, ARIA (once the list is a tablist), the narration.
  const select = (root, n) => {
    root.querySelectorAll('.away-tab').forEach((t, i) => {
      t.classList.toggle('is-on', i === n - 1);
      if (t.getAttribute('role') === 'tab') { t.setAttribute('aria-selected', String(i === n - 1)); t.tabIndex = i === n - 1 ? 0 : -1; }
    });
    const panel = root.querySelector('.away-panel');
    if (panel.hasAttribute('role')) panel.setAttribute('aria-labelledby', 'away-tab-' + n + '-t');
    for (const p of root.querySelectorAll('[data-away-narr]')) p.hidden = p.getAttribute('data-away-narr') !== String(n);
  };

  // [t,'away-row',n] makes tab n active and fills its hairline; [t,'away-row',n,true] lands it full.
  M.op('away-row', (c, n, done) => {
    const all = bars(c.root), bar = all[n - 1];
    if (done) { bar.classList.remove('is-fill'); bar.classList.add('is-full'); return; }
    select(c.root, n);
    for (const b of all) {
      if (b === bar) continue;
      const was = b.classList.contains('is-fill') || b.classList.contains('is-full');
      b.classList.remove('is-fill', 'is-full');
      b.classList.toggle('is-past', was);
    }
    bar.classList.remove('is-past', 'is-full', 'is-fill');
    if (c.instant) { bar.classList.add('is-full'); return; }
    bar.style.setProperty('--fill', LEN[n] + 'ms');
    void bar.offsetWidth;
    bar.classList.add('is-fill');
  });

  // [t,'away-area',n]: the rail item of scene n (the rail never fades; only its state changes).
  M.op('away-area', (c, n) => {
    for (const b of c.qa('.away-rail [data-area]')) b.classList.toggle('is-on', b.getAttribute('data-area') === AREA[n]);
    c.q('.away-stage').classList.toggle('is-a4', n === 4);
  });

  M.take({
    name: 'away',
    seed: 31,
    cutMerge: 400,
    // tk.row: the tab the visitor picked (plays alone), or 0 for the whole pass.
    steps: (tk) => (tk.row ? ROWS[tk.row].concat([[LEN[tk.row], 'hold']])
      : shift(ROWS[1], AT[1]).concat(shift(ROWS[2], AT[2]), shift(ROWS[3], AT[3]), shift(ROWS[4], AT[4]), [[END, 'hold']])),
    // tA of a picked tab is the end of the scenes before it.
    reset(tk) {
      const n = tk.row || 1;
      if (n > 1) {
        let pre = [];
        for (let i = 1; i < n; i++) pre = pre.concat(shift(ROWS[i], AT[i]));
        M.run(tk.root, pre, { instant: true, seed: 31 });
      }
      for (const b of bars(tk.root)) b.classList.remove('is-fill', 'is-full', 'is-past');
      select(tk.root, n);
    },
    onHold(tk) { tk.row = 0; },
  });

  M.onBoot(() => {
    const tk = M.get('away');
    if (!tk) return;
    const root = tk.root, list = root.querySelector('.away-tabs');
    const tabs = Array.from(root.querySelectorAll('.away-tab'));
    const N = tabs.length;
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-labelledby', 'away-title');
    root.querySelector('.away-panel').setAttribute('role', 'tabpanel');
    for (const t of tabs) {
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-controls', 'away-panel');
      t.setAttribute('aria-labelledby', t.id + '-t');
      t.setAttribute('aria-describedby', t.id + '-l');
    }
    const orient = () => list.setAttribute('aria-orientation', M.bp() === 'phone' ? 'vertical' : 'horizontal');
    orient();
    M.on('bp', orient);
    select(root, tabs.findIndex((t) => t.classList.contains('is-on')) + 1 || 1);
    const choose = (n) => {
      tk.row = n;
      if (M.reduced) { tk.reset(); tk.settle(); } else tk.restart();
    };
    list.addEventListener('click', (e) => {
      const t = e.target.closest('.away-tab');
      if (t) choose(tabs.indexOf(t) + 1);
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(e.target.closest('.away-tab'));
      if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      const n = k === 'ArrowDown' || k === 'ArrowRight' ? (i + 1) % N : k === 'ArrowUp' || k === 'ArrowLeft' ? (i + N - 1) % N
        : k === 'Home' ? 0 : k === 'End' ? N - 1 : k === 'Enter' || k === ' ' ? i : -1;
      if (n < 0) return;
      e.preventDefault();
      tabs[n].focus();
      choose(n + 1);
    });
  });
}

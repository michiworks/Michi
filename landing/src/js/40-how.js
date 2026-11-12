/* 40-how.js (verbs): #how, brief §5.7, T1-T6, P15. One pass of three rows; as a tablist
   a picked row plays alone and holds (reduced motion: its final frame). */
{
  const LEN = [0, 4400, 4900, 4400]; // each row's scene, ms
  const AT = [0, 0, 5200, 10900]; // row starts in the pass
  const END = 15300;
  const SA = '.how-sa', SB = '.how-sb';
  const ROWS = [null, [
    // 1. Ask the agent to branch.
    [0, 'verb-row', 1],
    [150, 'type', '.how-d1', { rate: 22, jitter: 6, space: 16, until: 1400 }], [150, 'cls', SA, '-is-empty'],
    [1450, 'press', SA], [1450, 'clear', '.how-d1'], [1450, 'cls', SA, '+is-stop'], [1450, 'show', '.how-u1'],
    [1500, 'loop', '.how-a', 'is-streaming'],
    [1700, 'show', '.how-l1'], [1700, 'group', '.how-g1', 'run'],
    [1900, 'text', '.how-gm1', '1/2'],
    [2100, 'group', '.how-g1', 'done'], [2100, 'text', '.how-gm1', '0.1s'],
    [2200, 'stream', '.how-p1', { rate: 45, until: 2650 }],
    [2700, 'loop', '.how-a', 'is-streaming', false], [2700, 'cls', SA, '-is-stop +is-empty'],
    // Running is a static amber LoaderCircle in the app (BranchAnchorRow.tsx).
    [2750, 'row', '.how-bl'], [2840, 'row', '.how-br2'],
    [2900, 'show', '.how-bm1'], [2900, 'loop', '.how-bm1', 'is-working'],
    [3020, 'show', '.how-bm2'], [3020, 'loop', '.how-bm2', 'is-working'],
    [4400, 'verb-row', 1, true],
  ], [
    // 2. A second round, not a new chat. Opening Identity check unpins its bookmark.
    [0, 'verb-row', 2], [0, 'swap', '.how-a', '.how-b'], [0, 'verb-unpin'],
    [0, 'loop', '.how-bm2', 'is-working', false], [0, 'text', '.how-bst', 'New branch'],
    [400, 'cls', '.how-q1', '+is-tint'], [400, 'row', '.how-c1'],
    [850, 'cls', '.how-q2', '+is-tint'], [850, 'row', '.how-c2'],
    [1300, 'cls', '.how-q3', '+is-tint'], [1300, 'row', '.how-c3'],
    [1700, 'type', '.how-d2', { rate: 22, until: 2250 }], [1700, 'cls', SB, '-is-empty'],
    // The bubble is the last tail reported at 2350, so the list follows it.
    [2350, 'press', SB], [2350, 'clear', '.how-d2'], [2350, 'cls', SB, '+is-stop'],
    [2350, 'row', '.how-cmt', 'out'], [2350, 'cls', '.how-q', '-is-tint'], [2350, 'show', '.how-u2'],
    [2400, 'loop', '.how-b', 'is-streaming'],
    [2600, 'show', '.how-l2, .how-t2'],
    [2800, 'stream', '.how-p2', { rate: 36, jitter: 8, until: 4550 }],
    [4600, 'loop', '.how-b', 'is-streaming', false], [4600, 'cls', SB, '-is-stop +is-empty'],
    // By 14:17 both branches are idle; the main pane is out of view until row 3.
    [4900, 'pick', '.how-bs', 1], [4900, 'text', '.how-n1', '4 messages', { ms: 0 }], [4900, 'text', '.how-tm', '8m', { ms: 0 }],
    [4900, 'verb-row', 2, true],
  ], [
    // 3. @ a branch or an artifact.
    [0, 'verb-row', 3], [0, 'swap', '.how-b', '.how-a'],
    [150, 'type', '.how-d3', { rate: 22, chip: 220, until: 1650 }], [150, 'cls', SA, '-is-empty'],
    [1750, 'press', SA], [1750, 'clear', '.how-d3'], [1750, 'cls', SA, '+is-stop'], [1750, 'show', '.how-u3'],
    [1800, 'loop', '.how-a', 'is-streaming'],
    [2000, 'show', '.how-l3, .how-t3'],
    [2200, 'tool', '.how-k3', 'run'], [2600, 'tool', '.how-k3', 'done'],
    [2700, 'stream', '.how-p3', { rate: 40, until: 4000 }],
    [4050, 'loop', '.how-a', 'is-streaming', false], [4050, 'cls', SA, '-is-stop +is-empty'],
    [4400, 'verb-row', 3, true],
  ]];
  const shift = (list, dt) => list.map((s) => [s[0] + dt].concat(s.slice(1)));
  const bars = (root) => root.querySelectorAll('.how-prog');

  // Selection: the active title, ARIA (once the list is a tablist), the narration.
  const select = (root, n) => {
    root.querySelectorAll('.how-tab').forEach((t, i) => {
      t.classList.toggle('is-on', i === n - 1);
      if (t.getAttribute('role') === 'tab') { t.setAttribute('aria-selected', String(i === n - 1)); t.tabIndex = i === n - 1 ? 0 : -1; }
    });
    const panel = root.querySelector('.how-panel');
    // Named by the tab's title only (labelledby does not recurse into the tab's own).
    if (panel.hasAttribute('role')) panel.setAttribute('aria-labelledby', 'how-tab-' + n + '-t');
    for (const p of root.querySelectorAll('[data-how-narr]')) p.hidden = p.getAttribute('data-how-narr') !== String(n);
  };

  // [t,'verb-row',n] makes row n active and fills its hairline; [t,'verb-row',n,true] lands it full.
  M.op('verb-row', (c, n, done) => {
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

  // Opening Identity check removes its bookmark (110 out); the other re-centres (220 pane, popLayout).
  M.op('verb-unpin', (c) => {
    const w1 = c.q('.how-bmw1'), w2 = c.q('.how-bmw2');
    c.q('.how-bm1').classList.add('is-off');
    const gone = (c2) => {
      if (c2.instant) { w1.classList.add('is-gone'); return; }
      const r = w2.getBoundingClientRect(), k = r.height / (w2.offsetHeight || 1) || 1;
      w1.classList.add('is-gone');
      const dy = (r.top - w2.getBoundingClientRect().top) / k;
      if (Math.abs(dy) < 0.5) return;
      w2.style.transition = 'none';
      w2.style.transform = 'translateY(' + dy.toFixed(2) + 'px)';
      void w2.offsetWidth;
      w2.style.transition = '';
      w2.style.transform = '';
    };
    if (c.instant) gone(c); else c.after(110, gone);
  });

  M.take({
    name: 'verbs',
    seed: 11,
    cutMerge: 400,
    // tk.row: the row the visitor picked (plays alone), or 0 for the whole pass.
    steps: (tk) => (tk.row ? shift(ROWS[tk.row], 0).concat([[LEN[tk.row], 'hold']])
      : shift(ROWS[1], AT[1]).concat(shift(ROWS[2], AT[2]), shift(ROWS[3], AT[3]), [[END, 'hold']])),
    // tA of a picked row is the end of the rows before it.
    reset(tk) {
      const n = tk.row || 1;
      if (n > 1) {
        let pre = [];
        for (let i = 1; i < n; i++) pre = pre.concat(shift(ROWS[i], AT[i]));
        M.run(tk.root, pre, { instant: true, seed: 11 });
      }
      for (const b of bars(tk.root)) b.classList.remove('is-fill', 'is-full', 'is-past');
      select(tk.root, n);
    },
    onHold(tk) { tk.row = 0; },
  });

  M.onBoot(() => {
    const tk = M.get('verbs');
    if (!tk) return;
    const root = tk.root, list = root.querySelector('.how-tabs');
    const tabs = Array.from(root.querySelectorAll('.how-tab'));
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-labelledby', 'how-title');
    root.querySelector('.how-panel').setAttribute('role', 'tabpanel');
    for (const t of tabs) {
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-controls', 'how-panel');
      t.setAttribute('aria-labelledby', t.id + '-t');
      t.setAttribute('aria-describedby', t.id + '-l');
    }
    const orient = () => list.setAttribute('aria-orientation', /^(desktop|phone)$/.test(M.bp()) ? 'vertical' : 'horizontal');
    orient();
    M.on('bp', orient);
    select(root, tabs.findIndex((t) => t.classList.contains('is-on')) + 1 || 3);
    const choose = (n) => {
      tk.row = n;
      if (M.reduced) { tk.reset(); tk.settle(); } else tk.restart();
    };
    list.addEventListener('click', (e) => {
      const t = e.target.closest('.how-tab');
      if (t) choose(tabs.indexOf(t) + 1);
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(e.target.closest('.how-tab'));
      if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      const n = k === 'ArrowDown' || k === 'ArrowRight' ? (i + 1) % 3 : k === 'ArrowUp' || k === 'ArrowLeft' ? (i + 2) % 3
        : k === 'Home' ? 0 : k === 'End' ? 2 : k === 'Enter' || k === ' ' ? i : -1;
      if (n < 0) return;
      e.preventDefault();
      tabs[n].focus();
      choose(n + 1);
    });
  });
}

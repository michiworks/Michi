/* 00-core.js (engine): the shared namespace M and the take engine: seeded rng,
   one rAF clock, takes, gating, controls, fitting, text tokens, follow-the-tail,
   debug API. Contract and examples: src/ENGINE.md. */
const M = {
  version: 1,
  list: [],                    // takes, in registration order
  byName: Object.create(null),
  ops: Object.create(null),    // op registry
  runs: [],                    // ad-hoc sequences (M.run)
  reduced: false,              // prefers-reduced-motion, live
  booted: false,
  gate: true,                  // IntersectionObserver gating (debug suspends it)
};

/* Utilities */
{
  M.$ = (sel, root) => (root || document).querySelector(sel);
  M.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  M.rng = (seed) => { // mulberry32
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  M.jit = (rng, base, j) => base + (rng() * 2 - 1) * (j || 0);
  // Phase lock: a loop started now lines up with every loop of its period.
  M.lock = (el) => {
    const n = performance.now(), s = el.style;
    s.setProperty('--ph1', -(n % 1000).toFixed(1) + 'ms');
    s.setProperty('--ph14', -(n % 1400).toFixed(1) + 'ms');
    s.setProperty('--ph24', -(n % 2400).toFixed(1) + 'ms');
  };
  M.flush = (el) => void (el || document.documentElement).offsetWidth;
  M.mq = (q) => matchMedia(q).matches;
  M.bp = () => (M.mq('(min-width: 1280px)') ? 'desktop' : M.mq('(min-width: 1024px)') ? 'laptop'
    : M.mq('(min-width: 768px)') ? 'tablet' : 'phone');
  M.touch = () => M.mq('(hover: none) and (pointer: coarse)');
  const hub = Object.create(null); // events: boot, start, hold, reduced, bp
  M.on = (evt, fn) => { (hub[evt] || (hub[evt] = [])).push(fn); };
  M.emit = (evt, ...args) => {
    for (const fn of hub[evt] || []) { try { fn(...args); } catch (e) { console.error('[michi] ' + evt, e); } }
  };
  M.op = (name, fn) => {
    if (typeof fn !== 'function') throw new TypeError('M.op(' + name + '): not a function');
    return (M.ops[name] = fn);
  };
}

/* Text tokens: [data-stream] -> .w words, [data-type] -> .c characters. */
{
  const TOKEN = (el) => el.hasAttribute('data-token') || el.classList.contains('mk-mention');
  const SKIP = (el) => el.tagName === 'BR' || el.tagName === 'svg' || el.classList.contains('mk-placeholder') || el.hasAttribute('data-skip');
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls + ' on';
    s.textContent = text;
    return s;
  };
  const split = (tn, kind) => {
    const frag = document.createDocumentFragment();
    const parts = kind === 'w' ? tn.nodeValue.split(/(\s+)/) : Array.from(tn.nodeValue);
    for (const p of parts) if (p) frag.appendChild(kind === 'w' && /^\s+$/.test(p) ? document.createTextNode(p) : span(kind, p));
    tn.parentNode.replaceChild(frag, tn);
  };
  const walk = (node, kind) => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === 3) { if (ch.nodeValue) split(ch, kind); }
      else if (ch.nodeType === 1 && !SKIP(ch)) {
        if (TOKEN(ch)) ch.classList.add(kind, 'on');
        else if (!ch.classList.contains(kind)) walk(ch, kind);
      }
    }
  };
  // Typed text: whitespace runs collapse to one space, the ends trim.
  const normalise = (el) => {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
    while (tw.nextNode()) if (!tw.currentNode.parentElement.closest('.mk-placeholder,[data-skip]')) nodes.push(tw.currentNode);
    nodes.forEach((n, i) => {
      let v = n.nodeValue.replace(/\s+/g, ' ');
      if (i === 0) v = v.replace(/^ /, '');
      if (i === nodes.length - 1) v = v.replace(/ $/, '');
      n.nodeValue = v;
    });
  };
  const INPUTS = '.mk-input, .mk-bcomp-input';
  M.prepare = (root) => {
    for (const el of M.$$('[data-stream]:not([data-prepped])', root)) { el.setAttribute('data-prepped', ''); walk(el, 'w'); }
    for (const el of M.$$('[data-type]:not([data-prepped])', root)) { el.setAttribute('data-prepped', ''); normalise(el); walk(el, 'c'); }
    for (const li of M.$$('li', root)) if (li.querySelector('.w')) li.classList.add('lw', 'on'); // markers follow words
    for (const i of M.$$(INPUTS, root)) if (i.querySelector('.c.on')) i.classList.add('has-text');
  };
  const inputsOf = (el) => {
    const own = el.closest?.(INPUTS);
    return own ? [own] : Array.from(el.querySelectorAll(INPUTS));
  };
  M.hideText = (el) => {
    for (const t of el.querySelectorAll('.w, .c')) t.classList.remove('on', 'rv', 'at');
    for (const li of el.querySelectorAll('li.lw')) li.classList.remove('on');
    if (el.matches?.('li.lw')) el.classList.remove('on');
    for (const i of inputsOf(el)) if (!i.querySelector('.c.on')) i.classList.remove('has-text');
  };
  M.showText = (el) => {
    for (const t of el.querySelectorAll('.w, .c')) { t.classList.remove('rv', 'at'); t.classList.add('on'); }
    for (const li of el.querySelectorAll('li.lw')) li.classList.add('on');
    for (const i of inputsOf(el)) if (i.querySelector('.c.on')) i.classList.add('has-text');
  };
}

/* Follow the tail (brief §5.12): the newest revealed thing sits 16 px above the
   composer. Without the engine the CSS bottom-anchors lists (tB); once it boots
   (html[data-motion]) they are top-anchored and only transforms move them, so
   nothing that grows (a row at the tail, comments in the composer) moves text
   in layout (CLS 0). Two layers: `transform` is the follow move (<= 0, 220 ms
   pane ease, at most every 300 ms); `translate` is the anchor, applied at once
   from a ResizeObserver, that keeps the last followed element 16 px above the
   composer while the list or its view resizes, as bottom anchoring did. */
{
  const pending = new Map(); // list -> { els (reported since the last move), tk, instant }
  const GAP = 16, EVERY = 300;
  const target = (list, el) => {
    const view = list.parentElement, h = list.offsetHeight;
    if (!view || !h) return null;
    const lr = list.getBoundingClientRect(), k = lr.height / h || 1, r = el.getBoundingClientRect();
    // A word ends at its line box (half-leading below its glyph box), so the
    // settled frame matches the CSS one (bottom-anchored list) to the pixel.
    const lead = el.matches('.w, .c') ? Math.max(0, (parseFloat(getComputedStyle(el).lineHeight) || 0) - r.height / k) / 2 : 0;
    return Math.min(0, view.clientHeight - GAP - ((r.bottom - lr.top) / k + lead)); // layout px (both rects carry the transforms)
  };
  const anchor = (list) => {
    const el = list._tail, d = el && el.isConnected && target(list, el);
    if (d == null || d === false) return;
    const a = Math.round((d - (list._ty || 0)) * 100) / 100;
    if (Math.abs(a - (list._a || 0)) < 0.5) return;
    list._a = a;
    list.style.translate = a ? '0 ' + a + 'px' : '';
  };
  let ro = null;
  const watch = (list) => {
    if (list._ro || !('ResizeObserver' in window)) return;
    list._ro = true;
    ro ||= new ResizeObserver((es) => {
      for (const l of new Set(es.map((e) => (e.target.hasAttribute('data-follow') ? e.target : e.target.querySelector(':scope > [data-follow]'))))) if (l) anchor(l);
    });
    ro.observe(list);
    if (list.parentElement) ro.observe(list.parentElement);
  };
  // Move the follow transform (el: the element it now follows). The anchor
  // offset is folded into it first, from the computed (in-flight) value.
  const set = (list, d, el) => {
    if (list._a) {
      const s = list.style, tr = s.transition, m = getComputedStyle(list).transform;
      s.transition = 'none';
      s.transform = 'translateY(' + ((m && m !== 'none' ? new DOMMatrixReadOnly(m).m42 : 0) + list._a) + 'px)';
      s.translate = '';
      list._a = 0;
      void list.offsetWidth;
      s.transition = tr;
    }
    list._ty = d = Math.round(d * 100) / 100;
    list._tail = el || null;
    list.style.transform = d ? 'translateY(' + d + 'px)' : '';
  };
  M.unfollow = (list) => { set(list, list._ty || 0); }; // stop anchoring (a hand-placed list, the hero at rest)
  const BLOCKS = '.e, .grow, [data-tail], .mk-user, .mk-thought, .mk-tool, .mk-group, .mk-blist';
  const hiddenIn = (el, list) => {
    for (let p = el; p && p !== list; p = p.parentElement) if (p.classList.contains('is-off')) return true;
    return false;
  };
  // The tail: the lowest visible token, or token-free visible block.
  M.tailOf = (list) => {
    let best = null, low = -Infinity;
    const consider = (el) => {
      if (!el || hiddenIn(el, list)) return false;
      const b = el.getBoundingClientRect().bottom;
      if (b > low) { low = b; best = el; }
      return true;
    };
    for (const sel of ['.w.on', '.c.on']) {
      const all = list.querySelectorAll(sel);
      for (let i = all.length - 1; i >= 0 && !consider(all[i]); i--);
    }
    for (const el of list.querySelectorAll(BLOCKS)) if (!el.querySelector('.w:not(.on), .c:not(.on)')) consider(el);
    return best;
  };
  M.fitTail = (list) => {
    watch(list);
    set(list, 0);
    const el = M.tailOf(list), d = el && target(list, el);
    if (d != null) set(list, d, el);
  };
  // Reveal ops report here; instant fits at once, play moves at most every 300 ms.
  M.tail = (c, el) => {
    const list = el?.closest?.('[data-follow]');
    if (!list || (c.root && !c.root.contains(list))) return;
    const p = pending.get(list);
    if (p) { p.els.add(el); p.tk = c.take; p.instant ||= !!c.instant; }
    else pending.set(list, { els: new Set([el]), tk: c.take, instant: !!c.instant });
  };
  // The list follows the lowest reported element still shown, so a class
  // change on an earlier line (cls) never pulls it back up, and an instant
  // finish lands on the real tail.
  M.flushTails = (force) => {
    for (const [list, p] of pending) {
      const t = p.tk ? p.tk.t : 0, now = force || p.instant;
      if (!now && list._fl != null && t >= list._fl && t - list._fl < EVERY) continue;
      pending.delete(list);
      let el = null, low = -Infinity;
      for (const x of p.els) {
        if (!x.isConnected || hiddenIn(x, list)) continue;
        const b = x.getBoundingClientRect().bottom;
        if (b > low) { low = b; el = x; }
      }
      const d = el && target(list, el);
      if (d != null && (now || d < (list._ty || 0) + (list._a || 0) - 0.5)) { set(list, d, el); list._fl = t; }
    }
  };
  M.dropTails = (root) => { for (const list of [...pending.keys()]) if (root.contains(list)) pending.delete(list); };
}

/* Fitting (brief §5.3): .mk-fit[data-w][data-h] gets --k from its parent's
   content width; data-k-min / data-k-max clamp; data-fit-vh="44" also fits it
   into 100svh below its own top. */
{
  let probe = null, queued = false, ro = null;
  const wraps = new Set();
  const svh = () => {
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
      document.body.appendChild(probe);
    }
    return probe.offsetHeight || innerHeight;
  };
  const num = (el, name, d) => { const v = parseFloat(el.getAttribute(name)); return Number.isFinite(v) ? v : d; };
  M.fit = (w) => {
    const p = w.parentElement;
    if (!p) return;
    const css = getComputedStyle(w);
    const W = num(w, 'data-w', 0) || parseFloat(css.getPropertyValue('--w')) || 0;
    const H = num(w, 'data-h', 0) || parseFloat(css.getPropertyValue('--h')) || 0;
    const pc = getComputedStyle(p);
    const avail = p.clientWidth - parseFloat(pc.paddingLeft) - parseFloat(pc.paddingRight);
    if (!W || !H || avail <= 0) return; // hidden composition
    const kMin = num(w, 'data-k-min', 0);
    let k = Math.min(num(w, 'data-k-max', 1), avail / W);
    if (w.hasAttribute('data-fit-vh')) {
      // The box sits at its parent's content top. Measure that, not the box: its
      // own settle translate (40-hero.css) must not feed back into k.
      const top = p.getBoundingClientRect().top + p.clientTop + parseFloat(pc.paddingTop) + scrollY;
      const kv = (svh() - top - num(w, 'data-fit-vh', 0)) / H;
      k = Math.min(k, Math.max(kMin, kv));
    }
    k = Math.round(Math.max(kMin, k) * 10000) / 10000;
    if (w._k !== k) {
      w._k = k;
      w.style.setProperty('--k', String(k));
      w.setAttribute('data-k', k.toFixed(3));
    }
  };
  M.k = (el) => el.closest('.mk-fit')?._k || 1;
  // Resizes also refit the tails of idle takes (fluid compositions rewrap).
  M.refit = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      for (const w of wraps) if (w.isConnected) M.fit(w);
      for (const tk of M.list) tk.fit();
    });
  };
  M.fitAll = (root) => {
    if (!ro && 'ResizeObserver' in window) ro = new ResizeObserver(M.refit);
    for (const w of M.$$('.mk-fit', root)) {
      if (!wraps.has(w)) { wraps.add(w); if (ro && w.parentElement) ro.observe(w.parentElement); }
      M.fit(w);
    }
  };
  addEventListener('resize', M.refit, { passive: true });
}

/* The take engine (brief §5.12) */
{
  let raf = 0, last = 0;
  const CUT = 700; // reduced motion: discrete cuts 700 ms apart

  const report = (tk, e, it) => {
    tk.errors.push(String(e?.message || e));
    console.error('[michi] take "' + tk.name + '"' + (it ? ' step ' + (typeof it.op === 'string' ? it.op : 'fn') + '@' + it.at : ''), e);
  };

  // Queue items { at, seq, op, args }, kept sorted by (at, seq).
  const insert = (tk, item) => {
    const q = tk.queue;
    item.seq = tk.seq++;
    let lo = 0, hi = q.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (q[mid].at <= item.at) lo = mid + 1; else hi = mid; }
    q.splice(lo, 0, item);
  };
  const ctx = (tk, at, instant) => {
    const c = {
      take: tk, root: tk.root, t: at, instant: !!instant, rng: tk.rng,
      q: (s) => tk.q(s), qa: (s) => tk.qa(s),
      at: (ms, fn, ...args) => insert(tk, { at: Math.max(ms, at), op: fn, args }),
      after: (ms, fn, ...args) => insert(tk, { at: at + ms, op: fn, args }),
      op: (name, ...args) => {
        if (!M.ops[name]) throw new Error('unknown op "' + name + '"');
        return M.ops[name](c, ...args);
      },
      tail: (el) => M.tail(c, el),
    };
    return c;
  };
  const drain = (tk, until, instant) => {
    const q = tk.queue;
    let n = 0;
    while (q.length && q[0].at <= until) {
      const it = q.shift();
      // Steps mode holds after its last cut; live mode holds here (later steps run as a coda).
      if (it.op === 'hold') { if (tk.state !== 'held' && tk.mode !== 'steps') hold(tk); continue; }
      const fn = typeof it.op === 'function' ? it.op : M.ops[it.op];
      if (!fn) report(tk, new Error('unknown op "' + it.op + '"'), it);
      else { try { fn(ctx(tk, it.at, instant), ...it.args); } catch (e) { report(tk, e, it); } }
      if (++n > 200000) { report(tk, new Error('runaway queue')); q.length = 0; }
      if (tk.cancelled) return;
    }
  };
  const compile = (tk) => {
    const raw = typeof tk.def.steps === 'function' ? tk.def.steps(tk) : tk.def.steps || [];
    tk.queue = [];
    tk.seq = 0;
    tk.t = 0;
    tk.rng = M.rng(tk.def.seed ?? 1);
    let end = 0, holdAt = null;
    const times = [];
    for (const s of raw) {
      if (!Array.isArray(s)) continue;
      const at = +s[0] || 0;
      insert(tk, { at, op: s[1], args: s.slice(2) });
      if (s[1] === 'hold') holdAt = at;
      end = Math.max(end, at);
      times.push(at);
    }
    tk.end = holdAt ?? end;
    // Reduced-motion cuts: step times, merged when closer than cutMerge.
    const merge = tk.def.cutMerge ?? 240;
    tk.cuts = [];
    for (const t of times.sort((a, b) => a - b)) if (!tk.cuts.length || t - tk.cuts[tk.cuts.length - 1] >= merge) tk.cuts.push(t);
    tk.cutIndex = -1;
  };

  // tB snapshot: [el, class, style]; style undefined = managed elsewhere.
  const snapshot = (tk) => {
    tk.snap = [];
    for (const el of tk.root.querySelectorAll('*')) {
      if (el.classList.contains('w') || el.classList.contains('c')) continue;
      const keep = el.classList.contains('mk-fit') || el.hasAttribute('data-keep-style');
      tk.snap.push([el, el.getAttribute('class'), keep ? undefined : el.getAttribute('style')]);
    }
  };
  M.touchHTML = (tk, el) => { if (!tk.htmlSnap.has(el)) tk.htmlSnap.set(el, el.innerHTML); };
  const setAttr = (el, n, v) => { if (el.getAttribute(n) !== v) { if (v == null) el.removeAttribute(n); else el.setAttribute(n, v); } };
  const restore = (tk) => {
    for (const [el, h] of tk.htmlSnap) el.innerHTML = h;
    tk.htmlSnap.clear();
    for (const [el, cls, style] of tk.snap) {
      if (!el.isConnected) continue;
      setAttr(el, 'class', cls);
      if (style !== undefined) setAttr(el, 'style', style);
    }
    if (tk.attrSnap) { for (const [el, m] of tk.attrSnap) for (const [n, v] of m) setAttr(el, n, v); tk.attrSnap.clear(); }
    for (const el of tk.root.querySelectorAll('[data-rt]')) el.remove();
    M.showText(tk.root);
    for (const l of tk.root.querySelectorAll('[data-follow]')) { l.style.transform = l.style.translate = ''; l._ty = l._a = 0; l._fl = l._tail = null; }
  };
  // Declarative tA: data-t0="hide", data-ta="off|on|hide", data-ta-text, data-ta-cls="+a -b".
  M.applyTA = (root) => {
    for (const el of root.querySelectorAll('[data-t0~="hide"]')) el.classList.add('is-off');
    for (const el of root.querySelectorAll('[data-ta]')) {
      const v = ' ' + el.getAttribute('data-ta') + ' ';
      if (v.includes(' off ')) el.classList.add('is-off');
      if (v.includes(' on ')) el.classList.remove('is-off');
      if (v.includes(' hide ')) M.hideText(el);
    }
    for (const el of root.querySelectorAll('[data-ta-text]')) el.textContent = el.getAttribute('data-ta-text');
    for (const el of root.querySelectorAll('[data-ta-cls]')) {
      for (const tok of el.getAttribute('data-ta-cls').split(/\s+/)) {
        if (tok[0] === '+') el.classList.add(tok.slice(1));
        else if (tok[0] === '-') el.classList.remove(tok.slice(1));
      }
    }
  };

  // Controls, hold UI and data-take-state.
  const uiEls = (tk, sel) => {
    const res = Array.from(tk.root.querySelectorAll(sel));
    for (const e of document.querySelectorAll('[data-take-for="' + tk.name + '"]')) {
      if (e.matches(sel)) res.push(e);
      res.push(...e.querySelectorAll(sel));
    }
    return res;
  };
  const ui = (tk) => {
    if (tk.anon) return;
    tk.root.setAttribute('data-take-state', tk.state);
    const playing = tk.state === 'playing' || tk.state === 'paused', held = tk.state === 'held';
    let lost = false;
    const shown = [];
    for (const b of uiEls(tk, '[data-take-control]')) {
      const kind = b.getAttribute('data-take-control');
      const show = kind === 'pause' ? playing
        : kind === 'replay' ? !M.reduced && (held || (tk.state === 'armed' && tk.def.autoplay === false))
          : kind === 'play' ? M.reduced && held : false;
      if (kind === 'pause') b.setAttribute('aria-pressed', String(tk.state === 'paused'));
      if (!show && !b.hidden && document.activeElement === b) lost = true;
      b.hidden = !show;
      if (show) shown.push(b);
    }
    if (lost && shown[0]) shown[0].focus({ preventScroll: true });
    for (const el of uiEls(tk, '[data-take-hold]')) el.classList.toggle('is-off', !held);
  };

  // Live heading (P7/P8): at most one on the page.
  const live = (tk) => {
    for (const el of document.querySelectorAll('[data-live-for].is-live')) if (el.getAttribute('data-live-for') !== tk.name) el.classList.remove('is-live');
    for (const el of document.querySelectorAll('[data-live-for="' + tk.name + '"]')) el.classList.add('is-live');
  };

  // Scroll guard: more than px of scroll before beforeMs finishes the take.
  const unguard = (tk) => { if (tk._guard) { removeEventListener('scroll', tk._guard); tk._guard = null; } };
  const guard = (tk) => {
    unguard(tk);
    const g = tk.def.scrollGuard?.(tk);
    if (!g) return;
    const y0 = scrollY;
    tk._guard = () => {
      if (tk.state !== 'playing' || tk.t >= g.beforeMs) unguard(tk);
      else if (Math.abs(scrollY - y0) > g.px) { unguard(tk); tk.finish(); }
    };
    addEventListener('scroll', tk._guard, { passive: true });
  };

  // Instant work: no tweens (.instant), then a forced style flush.
  const instantly = (tk, fn) => {
    const r = tk.root, had = r.classList.contains('instant');
    r.classList.add('instant');
    try { fn(); } finally {
      M.flushTails(true);
      M.flush(r);
      if (!had) { r.classList.remove('instant'); requestAnimationFrame(() => r.classList.remove('instant')); }
    }
  };

  const hold = (tk) => {
    tk.state = 'held';
    tk.holds++;
    unguard(tk);
    tk.root.classList.remove('is-paused');
    ui(tk);
    if (!tk.anon) M.emit('hold', tk);
    if (tk.def.onHold) { try { tk.def.onHold(tk); } catch (e) { report(tk, e); } }
  };
  const drop = (r) => { const i = M.runs.indexOf(r); if (i >= 0) M.runs.splice(i, 1); };
  const cancelRunsIn = (root) => {
    for (const r of M.runs.slice()) if (root.contains(r.root)) { r.cancelled = true; r.queue.length = 0; drop(r); }
  };
  const safe = (tk, fn, ...a) => { if (fn) { try { fn(...a); } catch (e) { report(tk, e); } } };

  const proto = {
    q(sel) {
      if (typeof sel !== 'string') return sel;
      const el = this.root.querySelector(sel);
      if (!el) throw new Error('no element "' + sel + '" in take "' + this.name + '"');
      return el;
    },
    qa(sel) {
      if (sel == null) return [];
      if (typeof sel !== 'string') return sel.nodeType ? [sel] : Array.from(sel);
      return Array.from(this.root.querySelectorAll(sel));
    },
    reset() { // instant tA
      const tk = this;
      unguard(tk);
      cancelRunsIn(tk.root);
      M.dropTails(tk.root);
      tk.queue = [];
      tk.t = 0;
      tk.cancelled = false;
      instantly(tk, () => {
        tk.root.classList.remove('is-paused');
        restore(tk);
        M.applyTA(tk.root);
        safe(tk, tk.def.reset, tk, ctx(tk, 0, true));
        for (const l of tk.root.querySelectorAll('[data-follow]')) M.fitTail(l);
      });
      tk.state = 'armed';
      ui(tk);
      return tk;
    },
    settle() { // instant tB: tA, then every step at once
      const tk = this;
      if (tk.state !== 'armed') tk.reset();
      instantly(tk, () => {
        if (tk.def.settle) { safe(tk, tk.def.settle, tk, ctx(tk, 0, true)); tk.queue = []; }
        else { compile(tk); drain(tk, Infinity, true); }
        tk.t = tk.end;
        if (tk.state !== 'held') hold(tk);
      });
      return tk;
    },
    play(opts) {
      const tk = this, o = opts || {};
      if (tk.state === 'paused') return tk.resume();
      if (!tk.anon && o.exclusive !== false) for (const x of M.list) if (x !== tk && x.busy()) x.finish(); // one at a time
      if (tk.state !== 'armed') tk.reset();
      compile(tk);
      tk.mode = o.steps ? 'steps' : 'live';
      tk.speed = o.speed || 1;
      tk.state = 'playing';
      tk.played = true;
      tk.starts++;
      if (o.skip > 0) tk.t = o.skip; // boot autoplay catches up with CSS that began at first paint
      if (tk.def.session) { try { sessionStorage.setItem(tk.def.session, '1'); } catch (e) { /* private mode */ } }
      if (!tk.anon) live(tk);
      if (tk.mode === 'live') guard(tk);
      ui(tk);
      if (!tk.anon) M.emit('start', tk);
      safe(tk, tk.def.onStart, tk);
      wake();
      return tk;
    },
    pause(by) {
      if (this.state !== 'playing') return this;
      this.state = 'paused';
      this.pausedBy = by || 'user';
      this.pausedAt = performance.now();
      this.root.classList.add('is-paused');
      ui(this);
      return this;
    },
    resume() {
      if (this.state !== 'paused') return this;
      this.state = 'playing';
      this.pausedBy = null;
      this.root.classList.remove('is-paused');
      // Live loops keep wall-clock phase (M.lock), like loops that start later:
      // skip each one over the pause, its stagger kept. One-shots follow take time.
      const L = performance.now() - this.pausedAt;
      for (const a of this.root.getAnimations?.({ subtree: true }) || []) {
        if (a.effect?.getTiming().iterations === Infinity && a.currentTime != null) a.currentTime += L;
      }
      ui(this);
      wake();
      return this;
    },
    finish() { // every remaining step at once, then hold
      const tk = this;
      if (tk.state === 'armed') return tk.settle();
      if (tk.state === 'held' && !tk.queue.length) return tk;
      unguard(tk);
      instantly(tk, () => {
        tk.root.classList.remove('is-paused');
        drain(tk, Infinity, true);
        tk.t = Math.max(tk.t, tk.end);
        if (tk.state !== 'held') hold(tk);
      });
      if (tk.anon) drop(tk);
      return tk;
    },
    // Focus on a control or in the figure (Replay, a Map card) moves to the
    // control that replaces it; the browser blurs hidden elements late.
    restart(o) {
      const ctl = uiEls(this, '[data-take-control]'), ae = document.activeElement;
      const own = !!ae && ae !== document.body && (this.root.contains(ae) || ctl.includes(ae));
      this.reset();
      this.play(o);
      const now = own && document.activeElement;
      if (own && (!now || now === document.body || now.closest('[hidden]') || !now.getClientRects().length)) {
        ctl.find((b) => !b.hidden)?.focus({ preventScroll: true });
      }
      return this;
    },
    fit() { // instant tail fit while idle: boot at tB, fonts, resizes, breakpoints
      if (this.busy()) return this;
      for (const l of this.root.querySelectorAll('[data-follow]')) {
        l.style.transition = 'none';
        M.fitTail(l);
        M.flush(l);
        l.style.transition = '';
      }
      safe(this, this.def.onFit, this);
      return this;
    },
    playSteps() { return this.restart({ steps: true }); }, // reduced motion: cuts 700 ms apart
    replay() { return M.reduced ? this.playSteps() : this.restart(); },
    busy() { return this.state === 'playing' || this.state === 'paused' || (this.state === 'held' && this.queue.length > 0); },
    info() {
      return { name: this.name, state: this.state, mode: this.mode, t: Math.round(this.t), end: this.end, holds: this.holds,
        starts: this.starts, played: this.played, vis: Math.round(this.vis * 100) / 100, errors: this.errors.slice() };
    },
  };

  const make = (def, root, anon) => Object.assign(Object.create(proto), {
    name: def.name, def, root, anon: !!anon, state: 'held', mode: 'live', speed: 1, t: 0, end: 0, queue: [], seq: 0,
    cuts: [], cutIndex: -1, rng: M.rng(def.seed ?? 1), vis: 0, played: false, holds: 0, starts: 0, errors: [],
    snap: [], htmlSnap: new Map(), frozen: false,
  });

  // Register a take (options: ENGINE.md §8).
  M.take = (def) => {
    if (!def?.name) throw new Error('M.take: a take needs a name');
    if (M.byName[def.name]) throw new Error('M.take: duplicate take "' + def.name + '"');
    const root = typeof def.root === 'string' ? document.querySelector(def.root)
      : def.root || document.querySelector('[data-take="' + def.name + '"]');
    if (!root) { console.warn('[michi] take "' + def.name + '": root not found, skipped'); return null; }
    if (!root.hasAttribute('data-take')) root.setAttribute('data-take', def.name);
    const tk = make(def, root, false);
    M.list.push(tk);
    M.byName[def.name] = tk;
    if (M.booted) M.bootTake(tk);
    return tk;
  };
  M.get = (name) => (typeof name === 'string' ? M.byName[name] : name) || null;

  // Ad-hoc sequence on the same clock: no gating, no controls.
  M.run = (root, steps, opts) => {
    const o = opts || {};
    const r = make({ name: o.name || 'run', steps, seed: o.seed, onHold: o.onHold }, root, true);
    M.runs.push(r);
    compile(r);
    r.state = 'playing';
    r.played = true;
    r.starts = 1;
    if (o.exclusive) for (const x of M.list) if (x.busy()) x.finish();
    if (M.reduced || o.instant) r.finish(); else wake();
    return r;
  };

  // The clock: advances running takes by min(dt, 50); sleeps when idle.
  const advance = (tk, dt) => {
    tk.t += dt * (tk.speed || 1);
    if (tk.mode === 'steps' && tk.state === 'playing') {
      const k = Math.floor(tk.t / CUT) - 1; // tA shows for one cut first
      while (tk.cutIndex < k && tk.cutIndex < tk.cuts.length - 1) {
        const until = ++tk.cutIndex + 1 < tk.cuts.length ? tk.cuts[tk.cutIndex + 1] - 0.001 : Infinity;
        instantly(tk, () => drain(tk, until, true));
      }
      if (tk.cutIndex >= tk.cuts.length - 1 && !tk.queue.length && tk.state === 'playing') hold(tk);
      return;
    }
    drain(tk, tk.t, false);
    if (!tk.queue.length && tk.state === 'playing' && tk.t >= tk.end) hold(tk);
  };
  const running = (tk) => tk.state === 'playing' || (tk.state === 'held' && tk.queue.length > 0 && !tk.frozen && !tk.cancelled);
  const tick = (now) => {
    raf = 0;
    const dt = Math.min(50, Math.max(0, now - last));
    last = now;
    let any = false;
    for (const tk of M.list) if (running(tk)) { any = true; advance(tk, dt); }
    for (const r of M.runs.slice()) {
      if (running(r)) { any = true; advance(r, dt); }
      if (r.state === 'held' && !r.queue.length) drop(r);
    }
    M.flushTails(false);
    if (any || M.runs.length) raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  M.wake = wake;

  /* Gating: one IntersectionObserver, thresholds [0, .25, .5]. Start at >= 50 %
     once per load, finish below 25 %. A tall box counts the viewport share it fills. */
  const sincePaint = () => {
    const p = performance.getEntriesByType?.('paint') || [];
    const fp = p.find((e) => e.name === 'first-contentful-paint') || p[0];
    return fp ? Math.max(0, performance.now() - fp.startTime) : 0;
  };
  M.canAutoplay = (tk) => !M.reduced && tk.def.autoplay !== false && !tk.played && (!tk.def.canAutoplay || tk.def.canAutoplay(tk));
  M.gateTake = (tk) => {
    if (!M.gate || !M.booted || tk.anon) return;
    if (tk.state === 'armed') {
      if (tk.vis >= 0.5 && M.canAutoplay(tk)) tk.play({ skip: tk.bootPlay && tk.def.catchUp ? Math.min(tk.def.catchUp, sincePaint()) : 0 });
    } else if (tk.vis < 0.25) {
      if (tk.busy()) tk.finish();
      for (const r of M.runs.slice()) if (tk.root.contains(r.root)) r.finish();
    }
    tk.bootPlay = false;
  };
  let io = null;
  M.observe = (tk) => {
    if (!('IntersectionObserver' in window)) return;
    io ||= new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = e.target, rh = e.rootBounds ? e.rootBounds.height : innerHeight;
        const vis = Math.max(e.intersectionRatio, rh ? e.intersectionRect.height / rh : 0);
        for (const tk of t.__takes || []) { tk.vis = vis; M.gateTake(tk); }
        if (t.__live && !e.isIntersecting) t.classList.remove('is-live');
      }
    }, { threshold: [0, 0.25, 0.5] });
    const el = tk.observeEl || tk.root;
    (el.__takes ||= []).push(tk);
    io.observe(el);
  };
  M.observeLive = (el) => { if (io && !el.__live) { el.__live = true; io.observe(el); } };

  // Debug API (window.__michi): list, state, finishAll, playAll(speed), reduced, bp.
  M.debugApi = () => ({
    version: M.version,
    list: () => M.list.map((tk) => tk.info()),
    state: (name) => M.get(name)?.info() || null,
    finishAll: () => {
      for (const r of M.runs.slice()) r.finish();
      for (const tk of M.list) tk.finish();
      return M.list.map((tk) => tk.info());
    },
    playAll: async (speed = 1, timeoutMs = 60000) => {
      const prev = M.gate;
      M.gate = false; // one at a time, gating suspended
      try {
        for (const tk of M.list) {
          if (M.reduced) tk.playSteps(); else tk.restart();
          tk.speed = speed;
          const limit = performance.now() + timeoutMs;
          while (tk.busy() && performance.now() < limit) await new Promise((r) => setTimeout(r, 40));
          if (tk.busy()) tk.finish();
        }
      } finally { M.gate = prev; }
      return M.list.map((tk) => tk.info());
    },
    reduced: () => M.reduced,
    bp: () => M.bp(),
  });

  M._ = { snapshot, ui };
}

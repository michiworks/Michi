/* 05-ops.js (engine): generic ops. A step is [atMs, 'op', ...args]; an op is
   fn(c, ...args), c = { take, root, t, instant, rng, q, qa, at, after, op, tail }.
   target = selector in the take root, element or list. Reference: ENGINE.md §8.1. */
{
  const off = (el) => el.classList.add('is-off');
  const each = (c, target, fn, o) => {
    const els = c.qa(target), st = o?.stagger;
    els.forEach((el, i) => (st && i && !c.instant ? c.after(i * st, (c2) => fn(c2, el, i)) : fn(c, el, i)));
    return els;
  };
  const show = (c, el, o) => {
    if (o?.ms != null) el.style.setProperty('--e-in', o.ms + 'ms');
    el.classList.remove('is-off');
    c.tail(el);
  };
  const hide = (c, el, o) => {
    if (o?.ms != null) el.style.setProperty('--e-out', o.ms + 'ms');
    off(el);
  };
  // Fit offsets (first = 0) into o.for ms, or to end at absolute o.until.
  const fitTimes = (c, at, o) => {
    const span = o.for ?? (o.until != null ? o.until - c.t : null), last = at[at.length - 1];
    return span > 0 && last > 0 ? at.map((x) => (x * span) / last) : at;
  };
  const isTok = (el) => el.classList.contains('mk-mention') || el.hasAttribute('data-token');

  M.op('show', (c, t, o) => each(c, t, (c2, el) => show(c2, el, o), o));
  M.op('hide', (c, t, o) => each(c, t, (c2, el) => hide(c2, el, o), o));
  M.op('enter', M.ops.show);
  M.op('exit', M.ops.hide);

  // '+a -b ~c': add (phase-locked), remove, toggle.
  M.op('cls', (c, t, spec, o) => each(c, t, (c2, el) => {
    for (const tok of String(spec).split(/\s+/)) {
      if (!tok) continue;
      const k = tok.slice(1);
      if (tok[0] === '-') el.classList.remove(k);
      else if (tok[0] === '~') el.classList.toggle(k);
      else { M.lock(el); el.classList.add(tok[0] === '+' ? k : tok); }
    }
    c2.tail(el);
  }, o));

  // A live-state class that runs a loop (is-streaming, is-live, is-working).
  M.op('loop', (c, t, cls, on) => each(c, t, (c2, el) => {
    if (on === false) el.classList.remove(cls);
    else { M.lock(el); el.classList.add(cls); }
  }));

  M.op('css', (c, t, prop, v) => each(c, t, (c2, el) => (v == null ? el.style.removeProperty(prop) : el.style.setProperty(prop, String(v)))));

  // Attribute (null removes); reset restores the tB value.
  M.op('attr', (c, t, name, v) => each(c, t, (c2, el) => {
    const tk = c2.take, snap = tk.attrSnap || (tk.attrSnap = new Map());
    const m = snap.get(el) || new Map();
    if (!m.has(name)) m.set(name, el.getAttribute(name));
    snap.set(el, m);
    if (v == null) el.removeAttribute(name); else el.setAttribute(name, String(v));
  }));

  M.op('call', (c, fn, ...args) => fn(c, ...args));

  // One-shot class for ms; skipped when instant.
  M.op('fx', (c, t, cls, ms) => each(c, t, (c2, el) => {
    el.classList.remove(cls);
    if (c2.instant) return;
    void el.offsetWidth;
    el.classList.add(cls);
    c2.after(ms || 600, () => el.classList.remove(cls));
  }));

  M.op('press', (c, t, o) => each(c, t, (c2, el) => {
    if (c2.instant) { el.classList.remove('is-pressed'); return; }
    el.classList.add('is-pressed');
    c2.after(o?.down || 45, () => el.classList.remove('is-pressed'));
  }));

  // Typing (brief H6). The input shows the caret while typing; chips snap in.
  const typeOne = (c, ch, input, caret) => {
    input.querySelector('.c.at')?.classList.remove('at');
    ch.classList.add('on');
    if (caret) ch.classList.add('at');
    input.classList.add('has-text');
    if (isTok(ch)) c.op('fx', ch, 'fx-snap', 100);
    c.tail(ch);
  };
  M.op('type', (c, t, o = {}) => {
    const box = c.q(t), input = box.closest('.mk-input, .mk-bcomp-input') || box;
    const chars = Array.from(box.querySelectorAll('.c'));
    const rate = o.rate ?? 26, jit = o.jitter ?? 6, sp = o.space ?? 20, stop = o.stop ?? 90, comma = o.comma ?? 50, chip = o.chip ?? 220;
    let at = [], x = 0;
    for (const ch of chars) {
      at.push(x);
      const s = ch.textContent;
      x += Math.max(4, M.jit(c.rng, rate, jit)) + (isTok(ch) ? chip : s === ' ' ? sp : /[.?!]/.test(s) ? stop : /[,;:]/.test(s) ? comma : 0);
    }
    at = fitTimes(c, at, o);
    const caret = o.caret !== false;
    if (caret) input.classList.add('has-caret');
    chars.forEach((ch, i) => c.at(c.t + at[i], typeOne, ch, input, caret));
    if (caret && !o.keepCaret) {
      c.at(c.t + (at[at.length - 1] || 0) + 1, () => {
        input.classList.remove('has-caret');
        input.querySelector('.c.at')?.classList.remove('at');
      });
    }
  });

  M.op('clear', (c, t, o) => each(c, t, (c2, el) => {
    const input = el.closest('.mk-input, .mk-bcomp-input') || el;
    for (const ch of input.querySelectorAll('.c')) ch.classList.remove('on', 'at', 'rv');
    input.classList.remove('has-text');
    if (o?.caret === false) input.classList.remove('has-caret');
  }));

  // Streaming (brief H16): each word fades .28 -> 1 over --t-decay.
  const SENTENCE = /[.?!][”’"')\]]*$/;
  const revealWord = (c, w) => {
    w.classList.add('on');
    if (!c.instant) w.classList.add('rv');
    w.closest('li.lw')?.classList.add('on');
    c.tail(w);
  };
  M.op('stream', (c, t, o = {}) => {
    const words = [];
    for (const el of c.qa(t)) el.classList.contains('w') ? words.push(el) : words.push(...el.querySelectorAll('.w'));
    const rate = o.rate ?? 62, jit = o.jitter ?? 10, pause = o.sentence ?? 90;
    let at = [], x = 0;
    for (const w of words) {
      at.push(x);
      x += Math.max(8, M.jit(c.rng, rate, jit)) + (SENTENCE.test(w.textContent) ? pause : 0);
    }
    at = fitTimes(c, at, o);
    words.forEach((w, i) => c.at(c.t + at[i], revealWord, w));
  });

  // Label text with a crossfade (plain labels only; reset restores the markup).
  M.op('text', (c, t, text, o) => each(c, t, (c2, el) => {
    const ms = o?.ms ?? 100;
    M.touchHTML(c2.take, el);
    if (c2.instant || !ms) { el.textContent = text; el.classList.remove('xf'); return; }
    let cur = el.classList.contains('xf') ? el.lastElementChild : null;
    if (!cur) {
      cur = document.createElement('span');
      cur.textContent = el.textContent;
      el.textContent = '';
      el.appendChild(cur);
      el.classList.add('xf');
    }
    el.style.setProperty('--xf-ms', ms + 'ms');
    const nx = document.createElement('span');
    nx.className = 'is-off';
    nx.textContent = text;
    el.appendChild(nx);
    void nx.offsetWidth;
    nx.classList.remove('is-off');
    cur.classList.add('is-off');
    c2.after(ms, () => { if (cur.parentNode === el) cur.remove(); });
  }));

  // In a stack of children (.xf), show child #index and hide the rest.
  M.op('pick', (c, t, index) => each(c, t, (c2, el) => {
    Array.from(el.children).forEach((ch, i) => ch.classList.toggle('is-off', i !== index));
  }));

  // Tool row/card and tool group: 'run' (enters if off) or 'done'.
  const state = (cls) => (c, t, s) => each(c, t, (c2, el) => {
    const x = el.classList.contains(cls) ? el : el.querySelector('.' + cls) || el;
    if (s === 'done') { x.classList.remove('is-running'); return; }
    M.lock(x);
    x.classList.add('is-running');
    if (el.classList.contains('is-off')) show(c2, el);
    c2.tail(el);
  });
  M.op('tool', state('mk-tool-row'));
  M.op('group', state('mk-group'));

  M.op('row', (c, t, dir, o) => each(c, t, (c2, el) => (dir === 'out' ? off(el) : show(c2, el)), o));
  M.op('chip', (c, t, o) => each(c, t, (c2, el) => { el.classList.add('on'); show(c2, el); c2.op('fx', el, 'fx-snap', 100); }, o));
  M.op('strike', (c, t) => each(c, t, (c2, el) => el.classList.remove('is-off')));

  // Move a follow list to an element (or its tail) now.
  M.op('follow', (c, list, tail) => each(c, list, (c2, l) => {
    const el = tail ? c2.q(tail) : M.tailOf(l);
    if (el) M.tail(c2, el);
  }));

  // Scene swap in a frame that never fades: out 110, in from +60 (.e-scene).
  M.op('swap', (c, outSel, inSel, o) => {
    const outs = c.qa(outSel), ins = c.qa(inSel);
    for (const el of outs) {
      if (c.instant) { off(el); el.classList.remove('is-out'); continue; }
      el.classList.add('is-out');
      c.after(110, () => { off(el); el.classList.remove('is-out'); });
    }
    const enter = (c2) => { for (const el of ins) { el.classList.remove('is-out'); show(c2, el); } };
    if (c.instant) enter(c); else c.after(o?.inAt ?? 60, enter);
  });

  // The hold point (the engine intercepts it; registered so the name is valid).
  M.op('hold', () => {});
}

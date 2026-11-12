/* 10-boot.js (engine): the boot protocol (brief §5.12) and live listeners
   (controls, reduced motion, tab visibility, breakpoints, fonts). M.boot() runs
   from 99-start.js; sections add setup with M.onBoot(fn). */
{
  const html = document.documentElement, hooks = [];
  const runHook = (fn) => { try { fn(); } catch (e) { console.error('[michi] onBoot', e); } };
  M.onBoot = (fn) => { if (M.booted) runHook(fn); else hooks.push(fn); };

  const rmq = matchMedia('(prefers-reduced-motion: reduce)');
  const intersects = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const sessionSet = (key) => { try { return !!sessionStorage.getItem(key); } catch (e) { return false; } };
  const observed = (tk) => {
    const x = tk.def.observe;
    return (typeof x === 'string' ? tk.root.querySelector(x) || document.querySelector(x) : x)
      || tk.root.querySelector('[data-take-observe]') || tk.root;
  };
  const onChange = (m, fn) => (m.addEventListener ? m.addEventListener('change', fn) : m.addListener(fn));

  /* Place a take at boot: tA (armed) or tB (held). The hero arms only with the
     head script's t0 before 2400 ms; others arm when not on screen; reduced
     motion holds everything. */
  M.bootTake = (tk, ctx = {}) => {
    tk.observeEl = observed(tk);
    M.prepare(tk.root);
    M._.snapshot(tk);
    const arm = M.reduced || tk.def.autoplay === false ? false
      : tk.def.hero ? !!(ctx.heroT0 && ctx.inTime)
        : tk.def.session && sessionSet(tk.def.session) ? false
          : !(ctx.hit ? ctx.hit.get(tk) : intersects(tk.observeEl));
    if (arm) { tk.reset(); tk.bootPlay = true; }
    else { tk.state = 'held'; M._.ui(tk); tk.fit(); } // tB lists, top-anchored from now on
    M.observe(tk);
    for (const el of document.querySelectorAll('[data-live-for="' + tk.name + '"]')) M.observeLive(el);
  };

  M.boot = () => {
    if (M.booted) return;
    html.classList.add('js');
    M.reduced = rmq.matches;
    // data-motion also top-anchors every follow list (30-kit.css); each take
    // fits its lists below, in this task, so no frame shows them unfitted.
    html.setAttribute('data-motion', M.reduced ? 'reduce' : 'full');
    const ctx = { heroT0: html.getAttribute('data-take-hero') === 't0', inTime: performance.now() < 2400, hit: new Map() };
    try {
      M.fitAll(document);
      for (const tk of M.list) ctx.hit.set(tk, intersects(observed(tk))); // read geometry before any reset writes
      for (const tk of M.list) {
        try { M.bootTake(tk, ctx); } catch (e) { tk.errors.push(String(e.message || e)); console.error('[michi] boot "' + tk.name + '"', e); }
      }
    } finally {
      html.setAttribute('data-hero-ready', ''); // same task as the hero's t0: no flash
      M.booted = true;
    }
    wire();
    hooks.splice(0).forEach(runHook);
    window.__michi = M.debugApi();
    M.emit('boot');
  };

  const takeFor = (el) => {
    const f = el.closest('[data-take-for]'), r = f ? null : el.closest('[data-take]');
    return f ? M.get(f.getAttribute('data-take-for')) : r ? M.get(r.getAttribute('data-take')) : null;
  };

  const wire = () => {
    // Take chrome: <button data-take-control="pause|replay|play">.
    document.addEventListener('click', (e) => {
      const b = e.target?.closest?.('[data-take-control]'), tk = b && takeFor(b);
      if (!tk) return;
      e.preventDefault();
      const kind = b.getAttribute('data-take-control');
      if (kind === 'pause') { if (tk.state === 'paused') tk.resume(); else tk.pause('user'); }
      else if (kind === 'replay') tk.replay();
      else if (kind === 'play') tk.playSteps();
    });

    // Reduced motion, live: switching it on mid-play finishes everything.
    onChange(rmq, () => {
      const on = rmq.matches;
      if (on === M.reduced) return;
      M.reduced = on;
      html.setAttribute('data-motion', on ? 'reduce' : 'full');
      if (on) {
        for (const r of M.runs.slice()) r.finish();
        for (const tk of M.list) if (tk.state !== 'held' || tk.busy()) tk.finish();
      }
      for (const tk of M.list) M._.ui(tk);
      M.emit('reduced', on);
    });

    // Hidden tab: pause; visible again: resume without a catch-up burst.
    document.addEventListener('visibilitychange', () => {
      for (const tk of M.list.concat(M.runs)) {
        if (document.hidden) { if (tk.state === 'playing') tk.pause('hidden'); else if (tk.busy()) tk.frozen = true; }
        else { tk.frozen = false; if (tk.state === 'paused' && tk.pausedBy === 'hidden') tk.resume(); }
      }
      if (!document.hidden) M.wake();
    });

    // A new composition mid-play: finish; armed takes re-apply tA for it.
    let bp = M.bp();
    const onBP = () => {
      const now = M.bp();
      if (now === bp) return;
      bp = now;
      for (const r of M.runs.slice()) r.finish();
      for (const tk of M.list) { if (tk.busy()) tk.finish(); else if (tk.state === 'armed') tk.reset(); else tk.fit(); }
      M.refit();
      M.emit('bp', now);
    };
    for (const q of ['(min-width: 1280px)', '(min-width: 1024px)', '(min-width: 768px)']) onChange(matchMedia(q), onBP);

    // Fonts swapping in can move line boxes by a hair: refit idle tails (tA and tB).
    document.fonts?.ready?.then(() => {
      M.refit();
      for (const tk of M.list) tk.fit();
    });

    // P1 without scroll timelines (20-components.css has the CSS): the nav
    // hairline shows once the page has scrolled past 8 px.
    const nav = document.querySelector('header.nav');
    const navRule = nav && !(window.CSS?.supports?.('animation-timeline: scroll()'))
      ? () => nav.classList.toggle('is-scrolled', scrollY > 8) : null;
    navRule?.();

    // A figure taller than the viewport: its IO ratio lags the viewport share it
    // fills (gating uses the share), so the [0, .25, .5] crossings fire late and
    // the last one before 0 can leave it above 25 %. Track the share directly.
    let queued = false;
    addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        navRule?.();
        const vh = innerHeight;
        for (const tk of M.list) {
          const el = tk.observeEl;
          if (!el || el.offsetHeight <= vh) continue;
          const r = el.getBoundingClientRect();
          tk.vis = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) / vh;
          M.gateTake(tk);
        }
      });
    }, { passive: true });
  };

  // Helpers for sections.
  M.mostVisible = () => M.list.reduce((b, tk) => (tk.vis > 0 && (!b || tk.vis > b.vis) ? tk : b), null);
  M.replay = (name) => M.get(name)?.replay() ?? null;
  M.finish = (name) => M.get(name)?.finish() ?? null;
}

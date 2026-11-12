// stageshow.html only: mounts the stageshow hero (michi-hero/) into the hero
// partial's [data-ss-hero] container. Built by build.mjs's sibling script
// (see README.md) into assets/ss/stageshow-hero.js + .css, React included.
// The page's own hero take holds still and stays hidden while this runs;
// without JavaScript, or if this bundle fails to load, the static replica
// shows instead (variant.css).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MichiHero } from './michi-hero/MichiHero'
import './variant.css'

declare global {
  interface Window { __ssHero?: { replay: () => void; el: Element } }
}

const el = document.querySelector('[data-ss-hero]')

function Hero() {
  // Replay remounts the scene at its story boundary (kit.md, Explicit replay)
  const [run, setRun] = useState(0)
  if (el) window.__ssHero = { replay: () => setRun((n) => n + 1), el }
  return <MichiHero key={run} />
}

if (el) {
  createRoot(el).render(<Hero />)
  el.setAttribute('data-ss-mounted', '')
  document.documentElement.setAttribute('data-ss-hero', 'ready')
  // CTA 2 ("Branch a sentence") replays the stage here. Caught before the
  // page's own listener on the button, which would branch the hidden replica
  // (and announce it to screen readers). B acts only while the replica is
  // visible (85-keys.js), so it rests on this page.
  window.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('[data-hero-branch]')) return
    e.stopPropagation()
    window.__ssHero?.replay()
  }, true)
}

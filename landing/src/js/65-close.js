/* 65-close.js (verbs): #get, brief §5.10, C1-C2. The Home caret blinks three times when the
   replica is first half in view; the rabbit tile is a button only while motion is allowed. */
{
  M.onBoot(() => {
    const sec = document.getElementById('get');
    if (!sec) return;
    const fit = sec.querySelector('.get-fit'), caret = sec.querySelector('.mk-caret');
    if (fit && caret && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => {
        if (!es.some((e) => e.intersectionRatio >= 0.5)) return;
        io.disconnect();
        if (!M.reduced) caret.classList.add('fx-blink3');
      }, { threshold: 0.5 });
      io.observe(fit);
    }

    const tile = sec.querySelector('.get-tile');
    if (!tile) return;
    let busy = false;
    const arm = () => {
      const btn = !M.reduced;
      tile.setAttribute('role', btn ? 'button' : 'img');
      tile.setAttribute('aria-label', btn ? 'Rabbit: take a detour' : 'Michi');
      if (btn) tile.tabIndex = 0;
      else { tile.removeAttribute('tabindex'); tile.classList.remove('is-dip'); }
    };
    const dip = () => {
      if (M.reduced || busy) return;
      busy = true;
      tile.classList.add('is-dip');
      setTimeout(() => { tile.classList.remove('is-dip'); busy = false; }, 840);
    };
    arm();
    M.on('reduced', arm);
    tile.addEventListener('click', dip);
    tile.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && tile.getAttribute('role') === 'button') { e.preventDefault(); dip(); }
    });
  });
}

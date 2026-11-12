/* ==========================================================================
   99-start.js (owner: engine). Every file has registered its takes, ops and
   hooks by now: boot (prepare text, place each take at tA or tB, hand the hero
   over from its CSS start frame) and start gating.
   ========================================================================== */
{
  const go = () => {
    try { M.boot(); } catch (e) {
      console.error('[michi] boot failed', e);
      document.documentElement.setAttribute('data-hero-ready', '');
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
}

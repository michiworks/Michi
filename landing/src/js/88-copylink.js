/* 88-copylink.js (figures): [data-copy-link] copies its value or this page's link (brief P13, G18). */
{
  document.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-copy-link]');
    if (!b) return;
    e.preventDefault();
    const s = b.getAttribute('data-copy-link') || location.href.split('#')[0], st = document.getElementById('copy-status');
    let ok = true;
    try { await navigator.clipboard.writeText(s); } catch (x) { // no Clipboard API here: a selected textarea
      const t = document.createElement('textarea');
      t.value = s;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;top:0;opacity:0;font-size:16px';
      document.body.appendChild(t);
      t.focus({ preventScroll: true });
      t.setSelectionRange(0, s.length);
      try { ok = document.execCommand('copy'); } catch (y) { ok = false; }
      t.remove();
      b.focus({ preventScroll: true });
    }
    if (!ok) return; // the label changes only when the copy worked
    b.classList.add('is-alt');
    if (st) st.textContent = 'Link copied';
    clearTimeout(b._copied);
    b._copied = setTimeout(() => { b.classList.remove('is-alt'); if (st) st.textContent = ''; }, 1600);
  });
}

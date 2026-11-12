/**
 * The document an HTML artifact's preview frame loads (ArtifactPreview.tsx).
 *
 * Isolation is the frame's: `sandbox="allow-scripts"` without
 * allow-same-origin gives the page an opaque origin, so its scripts can't
 * reach Michi's DOM, storage or cookies, and the API's origin guard refuses
 * its requests. Pages components are isolated the same way
 * (backend/src/services/pages/sandboxDocument.ts). The page is agent-written
 * and meant to run, so it is not sanitized.
 *
 * The policy below comes first in the document, before any of the page's own
 * markup, and only takes the network away: everything the page loads must be
 * inline, data: or blob:. A later policy from the page can only narrow it.
 * The mocks agents write inline their fonts, images and scripts, so they
 * render as they do opened from disk.
 *
 * Two shims stand in for what an opaque origin refuses: Web Storage, which
 * throws there and is kept in memory for the life of the preview instead, and
 * a history entry with a URL, which bundled apps write on load.
 */

export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'connect-src data: blob:',
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const SHIMS = `<script>(function(){
function memory(){var m=new Map();return{getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()},key:function(i){return Array.from(m.keys())[i]||null},get length(){return m.size}}}
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){Object.defineProperty(window,n,{value:memory(),configurable:true})}});
['pushState','replaceState'].forEach(function(n){var o=history[n].bind(history);history[n]=function(s,t,u){try{return o(s,t,u)}catch(e){return o(s,t)}}});
})();</script>`;

/** The page's own doctype goes: ours must come first, ahead of the policy. */
const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

export function artifactPreviewSrcdoc(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}">${SHIMS}${html.replace(LEADING_DOCTYPE, '')}`;
}

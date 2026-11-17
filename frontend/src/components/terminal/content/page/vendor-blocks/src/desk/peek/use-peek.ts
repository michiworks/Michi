// Michi shim for agent-desk src/desk/peek/use-peek.ts: only what the contents block (Toc.tsx) calls. Blocks are
// found by Michi's own markers (BlockFrame's data-block-id, a Markdown piece's data-segment-of) and lit as the Pages
// outline lights them: a glide there (TR-27) and data-reveal-flash, which holds its tint while the block arrives (MO-24).
import {parseSegmentId} from '../../../shared/markdown-segments';
import {reveal} from '../blocks/catalog/text/outline';
import {smoothScrollBehavior} from '../../../../../../../../hooks/useReducedMotion';
import {flashRevealed} from '../../../../../../../../state/pages/revealPageTarget';

/** What block `id` is drawn as on this page: its shell, else the pieces Michi cut its Markdown into. Desk cuts only top-level Markdown
 * (outline.ts names a heading inside a container by its whole block); Michi cuts it in containers too, so such a heading lands on its
 * block's pieces, which light up together as one block. A piece Michi drew whole lands on its block. Ids hold ':' and '/', so they are
 * compared rather than put in a selector. */
function shellsOf(root:ParentNode,id:string):HTMLElement[]{
 const all=[...root.querySelectorAll<HTMLElement>('[data-block-id],[data-segment-of]')];
 const own=all.find(el=>el.dataset.blockId===id);
 if(own)return [own];
 const pieces=all.filter(el=>el.dataset.segmentOf===id);
 if(pieces.length)return pieces;
 const piece=parseSegmentId(id);
 return piece?shellsOf(root,piece.blockId):[];
}
/** A toggle folded shut keeps its blocks on the page, hidden; each one around the block opens. */
function unfold(el:HTMLElement){
 for(let d=el.closest('details');d;d=d.parentElement?.closest('details')??null)d.open=true;
}
/** The rest of what `flashBlock` lights with a block handed over by whenRevealed. */
const together=new WeakMap<HTMLElement,HTMLElement[]>();

/** What puts out the last pick's flash, so a new pick lights only its own block. */
let lastOut:(()=>void)|null=null;
/** Glides to a block (at once under reduced motion) and lights it up for a moment, putting out the one lit before; returns what puts
 * it out early, which does nothing once a newer pick has come. The flash is the one revealPageTarget gives a located block, timer
 * included, so a second pick on the same block, or a reveal from elsewhere landing on it, starts its flash again. */
export function flashBlock(el:HTMLElement){
 lastOut?.();
 const lit=together.get(el)??[el];together.delete(el);
 el.scrollIntoView?.({behavior:smoothScrollBehavior(),block:'center'});
 const ends=lit.map(flashRevealed);
 const out=()=>{if(lastOut!==out)return;lastOut=null;for(const end of ends)end();};
 lastOut=out;
 return out;
}
/** Hands over block `id` once it is drawn, opening the toggles around it and asking a tab that holds it to show (outline.ts reveal), looking
 * again for a few frames; `missing` runs when it never shows. Returns what stops the looking. */
const TRIES=30;
export function whenRevealed(root:ParentNode,id:string,then:(el:HTMLElement)=>void,missing?:()=>void){
 let left=TRIES,live=true;
 const look=()=>{
  if(!live)return;
  const found=shellsOf(root,id);
  if(found.length){unfold(found[0]);together.set(found[0],found);then(found[0]);return;}
  if(left--<=0){missing?.();return;}
  reveal(id);requestAnimationFrame(look);
 };
 look();
 return()=>{live=false;};
}

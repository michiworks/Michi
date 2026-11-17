import {useEffect,useState} from 'react';
import type {BlockProps} from '../../types';
import './text.css';
import {L} from '../../../../../shared/i18n';

let ready=false,seq=0;
/** Diagrams draw in the page's own font and palette. Mermaid's themes take fixed colours, so the neutral one only lays the base, and these
 * rules (scoped by Mermaid to each diagram) paint nodes, lines and words from Michi's tokens; being variables, they follow a palette switch
 * without a redraw. A diagram's own classDef still wins: Mermaid marks those !important.
 * The node and label rules carry the flowchart, sequence, class, state and ER families. A pie's and a Gantt chart's own
 * words are their own classes, which the neutral theme writes in a fixed near-black no dark palette can read, so they
 * are named too. A slice's percentage is left alone: it sits on the slice's own light fill. */
const FONT='var(--ui-font, system-ui, sans-serif)';
const THEME_CSS=[
 '.node rect,.node circle,.node ellipse,.node polygon,.node path,.actor,.labelBox{fill:var(--term-surface);stroke:var(--term-line-s);stroke-width:1px}',
 '.cluster rect,.note,rect.note{fill:var(--term-alt);stroke:var(--term-line)}',
 '.flowchart-link,.edgePath .path,.relation,.messageLine0,.messageLine1,.actor-line,.transition{stroke:var(--term-mid)}',
 '.marker,marker path,.arrowheadPath,#arrowhead path,.arrowhead{fill:var(--term-mid);stroke:var(--term-mid)}',
 '.label,.nodeLabel,.edgeLabel,.cluster-label,.messageText,.noteText,.labelText,.loopText,text.actor>tspan{color:var(--term-fg);fill:var(--term-fg)}',
 '.edgeLabel,.edgeLabel p,.edgeLabel rect,.labelBkg{background-color:var(--term-surface);fill:var(--term-surface)}',
 '.pieTitleText,.legend text,text.legend{fill:var(--term-fg)}',
 '.titleText,.sectionTitle,.taskTextOutsideRight,.taskTextOutsideLeft,.grid .tick text{fill:var(--term-fg)}',
 'text,span,p,div{font-family:var(--ui-font, system-ui, sans-serif)}',
].join('');
/** Mermaid, loaded when a diagram is first drawn, in strict mode (its own sanitizer, no click handlers or HTML labels). Michi's chat
 * block brings English controls and its own chrome, so the page draws its own. Parsed before it is drawn, so a bad diagram leaves
 * nothing behind; then the source shows instead. */
export function MermaidBlock({block}:BlockProps<'mermaid'>){
 const [out,setOut]=useState<{code:string;svg?:string;failed?:boolean}|null>(null);
 useEffect(()=>{
  let live=true;const id=`desk-mermaid-${++seq}`;
  import('mermaid').then(async({default:mermaid})=>{
   if(!ready){mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral',fontFamily:FONT,themeVariables:{fontFamily:FONT},themeCSS:THEME_CSS});ready=true;}
   await mermaid.parse(block.code);
   const {svg}=await mermaid.render(id,block.code);
   if(live)setOut({code:block.code,svg});
  }).catch(()=>{document.getElementById(`d${id}`)?.remove();if(live)setOut({code:block.code,failed:true});});
  return()=>{live=false;};
 },[block.code]);
 const shown=out?.code===block.code?out:null;
 if(shown?.svg)return <div className="desk-mermaid" role="img" aria-label={L('流程图','Flowchart')} dangerouslySetInnerHTML={{__html:shown.svg}}/>;
 return <div className="desk-mermaid-src">
  {shown?.failed&&<p className="desk-quiet">{L('这张图画不出来，下面是原文','This diagram couldn’t be drawn. Here is the source')}</p>}
  <pre><code>{block.code}</code></pre>
 </div>;
}

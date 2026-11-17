import type {BlockProps} from '../../types';
import {Title} from './Title';
import './time.css';
import {L} from '../../../../../shared/i18n';

/** Steps a row holds side by side, as Milestones does (MILESTONE_TRACK_MAX); more stack. */
const ROW_MAX=6;
type StepState='done'|'next'|'later';
const stateText=(st:StepState)=>st==='done'?L('已完成','Done'):st==='next'?L('进行中','Now'):'';

/**
 * Steps drawn the way Milestones are (michiPage.css .michi-doc-track): a rule over each step marks it done, current or still to come,
 * then its number, name and words. Read-only: no step can be clicked. Past the last step every step is done (the schema clamps `current`
 * to the step count). A long run stacks, rule on the left.
 */
export function StepperBlock({block,hid}:BlockProps<'stepper'>){
  const state=(i:number):StepState=>i<block.current?'done':i===block.current?'next':'later';
  return <div className="michi-doc-track-host">
    <Title id={hid} text={block.title}/>
    <ol className="michi-doc-track" data-stack={block.steps.length>ROW_MAX||undefined} aria-labelledby={block.title?hid:undefined}>
      {block.steps.map((s,i)=>{const st=state(i),note=s.text?.trim()||stateText(st);
        return <li key={i} className="michi-doc-track__item" data-state={st} aria-current={st==='next'?'step':undefined}>
          <span className="michi-doc-track__when">{i+1}</span>
          <span className="michi-doc-track__label">{s.label}</span>
          {note&&<span className="michi-doc-track__note">{note}</span>}
        </li>;})}
    </ol>
  </div>;
}

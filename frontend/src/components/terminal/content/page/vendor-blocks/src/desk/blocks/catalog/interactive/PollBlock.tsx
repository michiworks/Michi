import {useState} from 'react';
import {Button,Checkbox,Radio,Tooltip} from '@mantine/core';
import {signature} from '../../../hash';
import type {BlockProps} from '../../types';
import {useBlockSend} from './useBlockSend';
import {SubmitFailedNote,SubmittedNote} from './SubmittedNote';
import {L} from '../../../../../shared/i18n';

/** Choices are told apart by their place, so two options worded the same still are two. */
const place=(options:string[],picked:string[])=>options.filter((_,i)=>picked.includes(String(i)));
// Michi: a stored submission is the picked places, as numbers in the order the options are written.
const placesOf=(value:unknown)=>Array.isArray(value)?value.filter((i):i is number=>Number.isInteger(i)).map(String):[];
/** A question and its options; 「投票」 sends the pick, one option or, for `multi`, several in the order they are written. A pick is a place,
 * so a poll rewritten with other options under the same id starts again unpicked. Michi: where the host keeps submissions the pick is
 * stored before it goes, and a poll voted in shows its pick read-only. */
export const PollBlock=(p:BlockProps<'poll'>)=><Poll key={signature([p.block.options,!!p.block.multi])} {...p}/>;
function Poll({block,ctx,hid}:BlockProps<'poll'>){
 const {question,options,multi}=block,{available,locked,sentLabel,submission,submit,saving,saveFailed}=useBlockSend(block,ctx),[choosing,setPicked]=useState<string[]>([]);
 const picked=submission?placesOf(submission.value):choosing;
 const vote=()=>{if(picked.length&&!submission)void submit(options.flatMap((_,i)=>picked.includes(String(i))?[i]:[]),L(`「${question}」我选：${place(options,picked).join('、')}`,`For “${question}” I pick: ${place(options,picked).join(', ')}`),question);};
 const items=options.map((o,i)=>multi?<Checkbox key={i} value={String(i)} label={o}/>:<Radio key={i} value={String(i)} label={o}/>);
 const button=<Button size="sm" disabled={!available||locked||saving||!picked.length} onClick={vote}>{locked?sentLabel:L('投票','Vote')}</Button>;
 return <>
  <h2 id={hid} className="desk-block-title">{question}</h2>
  <fieldset className="desk-submission-lock" disabled={!!submission}>
  {multi?<Checkbox.Group value={picked} onChange={setPicked} aria-labelledby={hid}><div className="desk-poll-options">{items}</div></Checkbox.Group>
   :<Radio.Group value={picked[0]??null} onChange={v=>setPicked([v])} aria-labelledby={hid}><div className="desk-poll-options">{items}</div></Radio.Group>}
  <div className="desk-poll-foot" aria-live="polite">{submission?<SubmittedNote submission={submission} now={ctx.now}/>:available?button:<Tooltip label={L('助手暂时不可用','The assistant isn’t available right now')}><span>{button}</span></Tooltip>}</div>
  {saveFailed&&<SubmitFailedNote/>}
  </fieldset>
 </>;
}

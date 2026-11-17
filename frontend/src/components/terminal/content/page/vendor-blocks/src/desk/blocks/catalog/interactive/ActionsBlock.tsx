import {useState} from 'react';
import {Button,Tooltip} from '@mantine/core';
import {Check} from 'lucide-react';
import type {BlockProps} from '../../types';
import {useBlockSend} from './useBlockSend';
import {SubmitFailedNote,SubmittedNote} from './SubmittedNote';
import {L} from '../../../../../shared/i18n';

/** Buttons that each send their own prompt to the assistant, this block along as context. The whole group is locked for a moment after one click.
 * Michi: in a chat reply (ctx.sendsAlways) a press is an answer: it is stored where the host keeps submissions, and the group then stays locked
 * on the button that was pressed, after a reload too. Before a press, the text each button sends is listed under them. */
export function ActionsBlock({block,ctx}:BlockProps<'actions'>){
 const answers=ctx.sendsAlways===true;
 const {available,locked,fire,submission,submit,saving,saveFailed}=useBlockSend(block,ctx),[sent,setSent]=useState<number|null>(null);
 const pressed=answers&&submission?pressedOf(submission.value):null;
 const click=(i:number)=>{
  const b=block.buttons[i];
  if(!answers){if(fire(b.prompt,b.label))setSent(i);return;}
  setSent(i);
  void submit({button:i,label:b.label},b.prompt,b.label);
 };
 const done=pressed!==null;
 const group=<div className="desk-actions">{block.buttons.map((b,i)=>{
  const mine=done?pressed===i:locked&&sent===i;
  return <Button key={i} variant={mine?'light':'default'} size="sm" disabled={!available||locked||saving||done} data-sent={mine||undefined}
   leftSection={mine?<Check size={14} strokeWidth={2} aria-hidden="true"/>:undefined} onClick={()=>click(i)}>{b.label}</Button>;
 })}</div>;
 // A pressed answer is a record: which button, as text at full contrast, no controls (DESIGN ST-31).
 if(done&&submission)return <>
  <p className="desk-actions-answer"><Check size={14} strokeWidth={2} aria-hidden="true"/>{block.buttons[pressed!]?.label??(submission.value as {label?:string})?.label??''}</p>
  <SubmittedNote submission={submission} now={ctx.now}/>
 </>;
 // A disabled button gets no pointer events, so the tooltip hangs on the group around them.
 return <>
  {available||done?group:<Tooltip label={L('助手暂时不可用','The assistant isn’t available right now')}>{group}</Tooltip>}
  {/* What each button sends in the user's name, before it is pressed; once one was, the answer line under the reply shows it. */}
  {answers&&!done?<ul className="desk-sends-list">{block.buttons.flatMap((b,i)=>b.prompt.trim()===b.label.trim()?[]:[<li key={i}><b>{b.label}</b> sends “{b.prompt}”</li>])}</ul>:null}
  {answers&&submission?<SubmittedNote submission={submission} now={ctx.now}/>:null}
  {answers&&saveFailed?<SubmitFailedNote/>:null}
 </>;
}

function pressedOf(value:unknown):number|null{
 const i=value&&typeof value==='object'?(value as {button?:unknown}).button:undefined;
 return typeof i==='number'&&Number.isInteger(i)&&i>=0?i:null;
}

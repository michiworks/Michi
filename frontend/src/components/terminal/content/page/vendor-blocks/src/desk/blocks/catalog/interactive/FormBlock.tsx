import {useState,type FormEvent} from 'react';
import {Button,Tooltip} from '@mantine/core';
import {DatesProvider} from '@mantine/dates';
import 'dayjs/locale/zh-cn';
import {signature} from '../../../hash';
import type {BlockProps} from '../../types';
import {useBlockSend} from './useBlockSend';
import {formFieldValueText} from 'michi-shared';
import {FieldControl,answerOf,blankValue,isMissing,type FieldRaw} from './FieldControl';
import {SubmitFailedNote,SubmittedNote} from './SubmittedNote';
import {L} from '../../../../../shared/i18n';

type Field=BlockProps<'form'>['block']['fields'][number];
// Michi: a stored submission's answers, by field key, as the controls hold them.
const submitted=(f:Field,value:unknown):FieldRaw=>{
 const answers=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 return Object.hasOwn(answers,f.key)?answers[f.key] as FieldRaw:blankValue(f);
};

/** A form of Mantine controls: submitting sends `prompt` and the values (by field key) to the assistant. A required field left empty stops the send and says so
 * beside it. After a send the values stay and the button says 「已发送」 for a moment. Values are kept by place, so a form rewritten with
 * other fields under the same id starts again empty. Michi: where the host keeps submissions the answers are stored before they go, and
 * a submitted form shows them read-only. */
export const FormBlock=(p:BlockProps<'form'>)=><Form key={signature(p.block.fields)} {...p}/>;
function Form({block,ctx,hid}:BlockProps<'form'>){
 const {title,fields,prompt,submitLabel}=block,{available,locked,sentLabel,submission,submit:store,saving,saveFailed}=useBlockSend(block,ctx);
 const [typed,setRaw]=useState<FieldRaw[]>(()=>fields.map(blankValue)),[bad,setBad]=useState<number[]>([]);
 const raw=submission?fields.map(f=>submitted(f,submission.value)):typed;
 const set=(i:number,v:FieldRaw)=>{setRaw(r=>r.map((x,j)=>j===i?v:x));setBad(b=>b.includes(i)?b.filter(j=>j!==i):b);};
 const submit=(event:FormEvent)=>{
  event.preventDefault();
  if(submission)return;
  const answers=fields.map((f,i)=>answerOf(f,raw[i])),empty=fields.flatMap((f,i)=>isMissing(f,answers[i])?[i]:[]);
  setBad(empty);
  if(empty.length)return;
  // Keys are the model's words: build the object by entries, so a key like __proto__ is a key and nothing more.
  const values=Object.fromEntries(fields.map((f,i)=>[f.key,answers[i]]));
  void store(values,`${prompt}\n\n${JSON.stringify(values)}`,title);
 };
 const control=(f:Field,i:number)=><FieldControl field={f} value={raw[i]} onChange={v=>set(i,v)}
  error={bad.includes(i)?(f.type==='checkbox'?L('请勾选','Check this'):f.type==='multiselect'?L('请至少选一项','Choose at least one'):L('请填写','Fill this in')):undefined}/>;
 const button=<Button type="submit" size="sm" disabled={!available||locked||saving}>{locked?sentLabel:submitLabel??L('提交','Submit')}</Button>;
 // Michi: a submitted form is a record, not a locked form: its answers as text at full contrast, no controls (DESIGN ST-31).
 if(submission)return <>
  <h2 id={hid} className="desk-block-title">{title}</h2>
  <dl className="desk-form-answers" aria-labelledby={hid}>
   {fields.map((f,i)=><div key={i} className="desk-form-answer"><dt>{f.label}</dt><dd>{formFieldValueText(f,answerOf(f,raw[i]))||'—'}</dd></div>)}
  </dl>
  <div className="desk-form-foot" aria-live="polite"><SubmittedNote submission={submission} now={ctx.now}/></div>
 </>;
 return <>
  <h2 id={hid} className="desk-block-title">{title}</h2>
  {/* Michi: where a press sends at once (a chat reply), say what goes out in the user's name before they press. */}
  {ctx.sendsAlways&&<p className="desk-sends">Sends “{prompt}” with your answers</p>}
  <DatesProvider settings={{locale:L('zh-cn','en'),firstDayOfWeek:1}}>
   <form className="desk-form" noValidate aria-labelledby={hid} onSubmit={submit}>
    {fields.map((f,i)=><div key={i} className="desk-form-field">{control(f,i)}</div>)}
    <div className="desk-form-foot" aria-live="polite">{available?button:<Tooltip label={L('助手暂时不可用','The assistant isn’t available right now')}><span>{button}</span></Tooltip>}</div>
    {saveFailed&&<SubmitFailedNote/>}
   </form>
  </DatesProvider>
 </>;
}

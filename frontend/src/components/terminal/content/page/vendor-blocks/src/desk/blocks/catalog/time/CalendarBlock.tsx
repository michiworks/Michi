import {useMemo} from 'react';
import {Tooltip} from '@mantine/core';
import {Month} from '@mantine/dates';
import 'dayjs/locale/zh-cn';
import type {BlockProps} from '../../types';
import {today} from '../../../db/db-ui';
import {Title} from './Title';
import './time.css';
import {L} from '../../../../../shared/i18n';
import {HOVER_TIP_DELAY_MS as TIP_DELAY_MS} from '../../../../../../../../../../components/ui/Popover';
import {DUR} from '../../../../../../../../../../motion/tokens';

const TIP_FADE={transition:'fade' as const,duration:Math.round(DUR.soft*1000),exitDuration:0};
/** Michi: the wait sorts a hover that means it from a pointer passing over (TR-14); a tap already means it, so a touch screen opens at once. */
const tipDelay=()=>window.matchMedia?.('(hover: hover)')?.matches?TIP_DELAY_MS:0;

const dayName=(date:string)=>L(`${+date.slice(5,7)}月${+date.slice(8)}日`,new Date(+date.slice(0,4),+date.slice(5,7)-1,+date.slice(8,10)).toLocaleDateString('en-US',{month:'short',day:'numeric'}));

/** A month, Monday first. A day with events has a dot under its number; hovering or focusing it lists them. The schema already dropped events
 * outside the month, since the month is all that is drawn. Michi: the events are also listed under the month by day, so their names are on
 * the page and not only in a tip. */
export function CalendarBlock({block,hid}:BlockProps<'calendar'>){
  const byDay=useMemo(()=>{
    const days=new Map<string,string[]>();
    for(const e of block.events){const list=days.get(e.date);if(list)list.push(e.title);else days.set(e.date,[e.title]);}
    return days;
  },[block.events]);
  const days=useMemo(()=>[...byDay].sort(([a],[b])=>a<b?-1:a>b?1:0),[byDay]);
  const now=today();
  const renderDay=(date:string)=>{
    const titles=byDay.get(date),num=<span className="desk-time-cal-num" data-today={date===now||undefined}>{+date.slice(8)}</span>;
    if(!titles)return num;
    // Michi: a tip waits as HoverTip's do (TR-14), fades in over --t-soft and leaves in one frame.
    return <Tooltip multiline maw={260} withArrow events={{hover:true,focus:true,touch:true}} openDelay={tipDelay()} transitionProps={TIP_FADE}
      label={<ul className="desk-time-cal-tip">{titles.map((t,i)=><li key={i}>{t}</li>)}</ul>}>
      <span className="desk-time-cal-mark" tabIndex={0} role="img" aria-label={L(`${dayName(date)}：${titles.join('、')}`,`${dayName(date)}: ${titles.join(', ')}`)}>{num}<i className="desk-time-cal-dot"/></span>
    </Tooltip>;
  };
  return <>
    <Title id={hid} text={block.title}/>
    <p className="desk-time-cal-month">{L(<>{block.month.slice(0,4)}年{+block.month.slice(5)}月</>,<>{new Date(+block.month.slice(0,4),+block.month.slice(5,7)-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'})}</>)}</p>
    <div className="desk-time-cal">
      {/* Static days are plain divs; every focus stop is the marked day itself, so the month's own tab stop is switched off. */}
      <Month month={`${block.month}-01`} static __preventFocus hideOutsideDates firstDayOfWeek={1} weekendDays={[]} locale={L('zh-cn','en')} size="md" renderDay={renderDay}
        getDayProps={()=>({'aria-label':undefined})}/>
    </div>
    {days.length>0&&<ul className="desk-time-cal-list">
      {days.map(([date,titles])=><li key={date} className="desk-time-cal-event">
        <span className="desk-time-cal-day">{dayName(date)}</span>
        <span className="desk-time-cal-names">{titles.map((t,i)=><span key={i}>{t}</span>)}</span>
      </li>)}
    </ul>}
  </>;
}

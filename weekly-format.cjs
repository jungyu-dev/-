'use strict';

// Formatting only: this module never reads credentials or sends messages.
const MAX_MESSAGE_BYTES = 28000;
const PHASES = ['실사', '배선', '조명설치', 'SW세팅', '검수인계'];
const PHASE_ICONS = {실사:'🔎', 배선:'🔌', 조명설치:'💡', SW세팅:'💻', 검수인계:'✅'};
const DEFAULT_SHEET_URL = '';
const DEFAULT_CALENDAR_URL = 'https://calanderv2.vercel.app/';
const GUIDANCE = '일정 확인 후 수정이 필요하거나 누락된 내용이 있으면 챗봇에 수정 요청을 하거나 현장 리스트에서 직접 수정해 주세요.\n이용 중 오류가 발생하면 솔루션팀 방에 공유해 주세요.';
const SEOUL_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23',
});
const KOREAN_SORT = new Intl.Collator('ko-KR');

function seoulParts(now){
  const instant = now instanceof Date ? now : new Date(now);
  if(!Number.isFinite(instant.getTime())) throw new RangeError('invalid_weekly_time');
  const parts = Object.fromEntries(SEOUL_CLOCK.formatToParts(instant).map(part=>[part.type,part.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`, hour:Number(parts.hour)};
}

function civilDate(value){
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('invalid_weekly_date');
  const date = new Date(value+'T00:00:00Z');
  if(!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new RangeError('invalid_weekly_date');
  return date;
}

function weekRange(now = new Date()){
  const date = civilDate(seoulParts(now).date);
  date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  const from = date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate()+6);
  return {from, to:date.toISOString().slice(0,10)};
}

function weeklySlot(now = new Date()){
  const local = seoulParts(now);
  if(civilDate(local.date).getUTCDay() !== 1 || local.hour !== 8) return null;
  return weekRange(now);
}

function dayLabel(value, includeYear = false){
  const date = civilDate(value);
  return `${includeYear ? date.getUTCFullYear()+'년 ' : ''}${date.getUTCMonth()+1}월 ${date.getUTCDate()}일 (${'일월화수목금토'[date.getUTCDay()]})`;
}

const clean = value=>String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g,' ').trim();
const normalizeName = value=>String(value ?? '').replace(/\s+/g,'');
const byteLength = value=>Buffer.byteLength(value,'utf8');
function compareText(a,b){
  return KOREAN_SORT.compare(a,b) || (a < b ? -1 : a > b ? 1 : 0);
}

function groupsFor(items){
  const groups = new Map();
  for(const item of items){
    if(!PHASES.includes(item.phase)) throw new RangeError('invalid_weekly_phase');
    civilDate(item.date);
    // Status and both assignments are part of the identity, even at the same address.
    const key = JSON.stringify([item.date,item.site,item.vendor,item.mgr,item.mgrSub,item.status]);
    if(!groups.has(key)) groups.set(key,{...item,phases:[]});
    groups.get(key).phases.push(item.phase);
  }
  return [...groups.values()].sort((a,b)=>{
    for(const field of ['date','site','vendor','mgr','mgrSub','status']){
      const order = compareText(a[field],b[field]);
      if(order) return order;
    }
    return 0;
  });
}

function groupText(group,manager){
  const phases = [...group.phases].sort((a,b)=>PHASES.indexOf(a)-PHASES.indexOf(b));
  let assignment;
  if(manager){
    assignment = [normalizeName(group.mgr) === normalizeName(manager) ? '정담당' : '',
      normalizeName(group.mgrSub) === normalizeName(manager) ? '부담당' : ''].filter(Boolean).join(' · ');
    if(!assignment) throw new RangeError('weekly_manager_mismatch');
  }else{
    assignment = `정: ${clean(group.mgr) || '미지정'} / 부: ${clean(group.mgrSub) || '미지정'}`;
  }
  const details = [clean(group.vendor),assignment].filter(Boolean).join(' · ');
  return `🏠 ${clean(group.site)}\n  ${details}\n  ${phases.map(phase=>`${PHASE_ICONS[phase]} ${phase}`).join(' · ')}`;
}

function formatWeeklyMessages(range,result,{manager = null,sheetUrl = DEFAULT_SHEET_URL,calendarUrl = DEFAULT_CALENDAR_URL} = {}){
  const groups = groupsFor(result.items);
  const heading = ['🔔 이번 주 현장 방문 일정',
    manager ? `${clean(manager)} 님, 이번 주 담당 현장 일정을 안내드려요.` : '솔루션팀 전체 현장 방문 일정을 안내드려요.',
    `📅 ${dayLabel(range.from,true)} ~ ${dayLabel(range.to,true)}`,
    `총 ${result.siteCount}개 현장 · 공정 일정 ${result.count}개`].join('\n');
  const footer = [GUIDANCE,sheetUrl ? `📋 현장 리스트: ${clean(sheetUrl)}` : '',
    calendarUrl ? `📅 공정 캘린더: ${clean(calendarUrl)}` : ''].filter(Boolean).join('\n');
  // Reserve the footer and the widest possible page counter on every page.
  // This keeps a site intact and avoids a final page containing only a footer.
  const maxPages = Math.max(1,groups.length);
  const reservedHeading = `${heading}\n[${maxPages}/${maxPages}]`;
  const fits = body=>byteLength(`${reservedHeading}\n\n${body}\n\n${footer}`) < MAX_MESSAGE_BYTES;
  const pages = [];
  let body = '', lastDate = '';
  for(const group of groups){
    const text = groupText(group,manager);
    const withDate = `📌 ${dayLabel(group.date)}\n${text}`;
    const addition = group.date === lastDate ? text : withDate;
    const candidate = body ? `${body}\n\n${addition}` : addition;
    if(fits(candidate)){
      body = candidate;
      lastDate = group.date;
      continue;
    }
    if(!fits(withDate)) throw new RangeError('weekly_group_too_large');
    pages.push(body);
    body = withDate;
    lastDate = group.date;
  }
  if(!groups.length){
    body = '이번 주 조건에 맞는 현장 공정 일정이 없어요.';
    if(!fits(body)) throw new RangeError('weekly_message_too_large');
  }
  pages.push(body);
  return pages.map((page,index)=>{
    const counter = pages.length > 1 ? `\n[${index+1}/${pages.length}]` : '';
    const ending = index === pages.length-1 ? `\n\n${footer}` : '';
    const message = `${heading}${counter}\n\n${page}${ending}`;
    if(byteLength(message) >= MAX_MESSAGE_BYTES) throw new RangeError('weekly_message_too_large');
    return message;
  });
}

module.exports = {weekRange,weeklySlot,formatWeeklyMessages};

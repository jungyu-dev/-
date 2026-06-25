/*** 카카오+슬랙+구글챗 비서 (Gemini · 검색 · 대화기억 · 캘린더 쓰기) ********
 * 읽기: 일정/메일/드라이브/시트 조회
 * 쓰기: 일정 추가·수정·삭제 (실행 전 "이렇게 할게요?" 확인)
 * 기억/대기작업: 서버 메모리 (재시작 시 초기화)
 * Render 환경변수: GAS_URL, GAS_TOKEN, GEMINI_API_KEY, (선택) GEMINI_MODEL
 *********************************************************************/
import express from 'express';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const GAS_URL   = process.env.GAS_URL;
const GAS_TOKEN = process.env.GAS_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

/* ===== 대화 기억 + 대기 작업 (서버 메모리) ===== */
const HISTORY = new Map();
const PENDING = new Map();
const MAX_TURNS = 6;
function getHistory(k){ return (k && HISTORY.get(k)) || []; }
function pushHistory(k, role, text){
  if(!k) return;
  const a = HISTORY.get(k) || [];
  a.push({ role, text: String(text).slice(0,300) });
  while(a.length > MAX_TURNS) a.shift();
  HISTORY.set(k, a);
}
function historyText(h){ return h.length ? h.map(x=>`${x.role==='user'?'사용자':'비서'}: ${x.text}`).join('\n') : '(없음)'; }
function setPending(k,v){ if(k) PENDING.set(k, {...v, ts:Date.now()}); }
function getPending(k){
  if(!k) return null;
  const p = PENDING.get(k);
  if(!p) return null;
  if(Date.now()-p.ts > 5*60*1000){ PENDING.delete(k); return null; } // 5분 만료
  return p;
}
function clearPending(k){ if(k) PENDING.delete(k); }
function pendingSummary(p){
  if(p.op==='create') return `추가: ${fmtEvent(p.event)}`;
  if(p.op==='delete') return `삭제: ${p.summary}`;
  if(p.op==='update') return `수정: ${p.summary}`;
  return '';
}
function fmtEvent(e){
  const t = e.title || '(제목 없음)';
  if(e.allDay) return `📅 ${e.date} (종일) ${t}`;
  const time = e.end ? `${e.start}–${e.end}` : e.start;
  return `📅 ${e.date} ${time} ${t}`;
}

/* ===== AI 호출 (503/429/500 자동 재시도) ===== */
async function askAI(prompt, tries=3){
  for(let i=0;i<tries;i++){
    try { const r = await model.generateContent(prompt); return r.response.text(); }
    catch(e){
      const s = e?.status || e?.response?.status;
      if((s===503||s===429||s===500) && i<tries-1){
        console.warn(`[retry] ${s} \u2014 ${1.5*(i+1)}s 후 재시도 (${i+1}/${tries-1})`);
        await new Promise(r=>setTimeout(r,1500*(i+1))); continue;
      }
      throw e;
    }
  }
}

app.get('/', (_q,res)=>res.send('skill server ok'));

/* ===== 카카오 ===== */
app.post('/skill', (req,res)=>{
  const ur = req.body?.userRequest || {};
  const key = ur.user?.id || null;
  res.json({ version:'2.0', useCallback:true, data:{ text:'🤔 잠깐만요, 확인하고 있어요…' } });
  if(!ur.callbackUrl) return;
  handleAsync(ur.utterance||'', key).then(t=>sendKakao(ur.callbackUrl,t))
    .catch(async e=>{ console.error('[kakao]',e?.message||e); await sendKakao(ur.callbackUrl,'⚠️ 처리 중 오류가 났어요.').catch(()=>{});});
});

/* ===== 슬랙 ===== */
app.post('/slack', (req,res)=>{
  const text = req.body?.text || '';
  const key = req.body?.user_id || null;
  const url = req.body?.response_url;
  res.json({ response_type:'ephemeral', text:'🤔 잠깐만요, 확인하고 있어요…' });
  if(!url) return;
  handleAsync(text,key).then(t=>postSlack(url,t))
    .catch(async e=>{ console.error('[slack]',e?.message||e); await postSlack(url,'⚠️ 처리 중 오류가 났어요.').catch(()=>{});});
});

/* ===== 구글 챗 ===== */
app.post('/gchat', async (req,res)=>{
  const ev = req.body || {};
  if(ev.type!=='MESSAGE') return res.json({ text:'안녕하세요! 일정·메일·드라이브·시트 조회와 일정 추가·수정·삭제를 도와드려요. 😊' });
  const key = ev.user?.name || ev.message?.sender?.name || null;
  const text = (ev.message?.text||'').replace(/^@\S+\s*/,'');
  try{ res.json({ text: await handleAsync(text,key) }); }
  catch(e){ console.error('[gchat]',e?.message||e); res.json({ text:'⚠️ 처리 중 오류가 났어요.' }); }
});

/* ===== 공통 두뇌 ===== */
async function handleAsync(utterance, key){
  const history = getHistory(key);
  const pending = getPending(key);
  const intent = await parseIntent(utterance, history, pending);
  let action = intent.action;
  if(!pending && (action==='confirm'||action==='cancel')) action='chat';

  let reply;
  if(pending && action==='confirm'){ reply = await execPending(pending); clearPending(key); }
  else if(pending && action==='cancel'){ clearPending(key); reply = '알겠어요, 취소했어요. 😊'; }
  else if(action==='create'||action==='update'||action==='delete'){ reply = await prepareWrite({...intent, action}, key); }
  else if(action==='chat'){ clearPending(key); reply = await chat(utterance, history); }
  else { clearPending(key); const gas = await fetchGas({...intent, action}); reply = await summarize(utterance, gas, history); }

  pushHistory(key,'user',utterance);
  pushHistory(key,'assistant',reply);
  return reply;
}

async function parseIntent(utterance, history, pending){
  const now = new Date();
  const today = now.toLocaleDateString('sv-SE',{ timeZone:'Asia/Seoul' });
  const weekday = now.toLocaleDateString('ko-KR',{ timeZone:'Asia/Seoul', weekday:'long' });
  const pendingBlock = pending
    ? `[대기 중 작업] 방금 사용자에게 이걸 확인 요청했어 → ${pendingSummary(pending)}
사용자 답이 긍정(응/네/맞아/그래/좋아/해줘)이면 action="confirm". 부정(아니/취소/안돼/하지마)이면 action="cancel". 시간·내용을 바꾸자는 거면 create/update/delete로 새 값 채워. 전혀 다른 요청이면 그대로.`
    : '';
  const prompt =
`오늘은 ${today} (${weekday}), Asia/Seoul. 아래 맥락을 보고 '이번 발화'를 분석해 JSON 한 줄만 출력해.
${pendingBlock}
[직전 대화]
${historyText(history)}
[이번 발화]
"${utterance}"

형식: {"action":"calendar|gmail|drive|sheet|chat|create|update|delete|confirm|cancel","from":null,"to":null,"gmailQuery":null,"driveQuery":null,"keyword":null,"event":{"title":null,"date":"yyyy-mm-dd|null","start":"HH:mm|null","end":"HH:mm|null","allDay":false,"target":null}}

[분류]
- 일정 조회→calendar, 메일→gmail, 드라이브/파일→drive, 시트→sheet
- 일정 추가→create, 일정 수정/변경→update, 일정 삭제/취소→delete
- 인사·잡담·불가능한 요청→chat
[맥락 이어받기] "그중에서/그건/그럼 그건/PDF로 된 거" 처럼 앞을 가리키면 직전 대화의 대상·조건을 이어받아 채워.
[calendar] from/to 날짜. "오늘"→from=to=오늘, 하루면 from=to 동일, "이번주/다음주/주말/이번달"은 범위, 없으면 null.
[gmail] gmailQuery=Gmail검색식 (from:이름 / is:unread / has:attachment / newer_than:3d). 막연하면 null.
[drive] driveQuery=Drive검색식 (title contains '단어' / mimeType = 'application/pdf' 등 and 조합, trashed 조건은 넣지 마). 막연하면 null.
[sheet] keyword=시트 이름 핵심 단어.
[event] create/update/delete일 때: title=제목, date=yyyy-mm-dd, start/end="HH:mm"(24시간, 없으면 null), "종일"이면 allDay=true. update/delete는 target에 기존 일정 찾을 키워드(제목 일부).
해당 없는 필드는 null. 설명·코드블록 없이 JSON 한 줄만.`;
  try{
    const txt = (await askAI(prompt)).replace(/```json|```/g,'').trim();
    const o = JSON.parse(txt);
    const ok = ['calendar','gmail','drive','sheet','chat','create','update','delete','confirm','cancel'];
    const c = v => (v && v!=='null' ? v : null);
    const ev = o.event || {};
    return {
      action: ok.includes(o.action)?o.action:'chat',
      from:c(o.from), to:c(o.to), gmailQuery:c(o.gmailQuery), driveQuery:c(o.driveQuery), keyword:c(o.keyword),
      event:{ title:c(ev.title), date:c(ev.date), start:c(ev.start), end:c(ev.end), allDay:!!ev.allDay, target:c(ev.target) },
    };
  }catch{ return { action:'chat', event:{} }; }
}

/* ===== 쓰기 준비 (확인 메시지 만들고 대기에 저장) ===== */
async function prepareWrite(intent, key){
  const e = intent.event || {};
  if(intent.action==='create'){
    if(!e.title) return '무슨 일정을 추가할까요? 제목을 알려주세요. 📝';
    if(!e.date)  return `'${e.title}' 일정을 며칠에 추가할까요? 📅`;
    if(!e.allDay && !e.start) return `'${e.title}' (${e.date}) — 몇 시로 잡을까요? ⏰ 종일로 하려면 "종일"이라고 해주세요.`;
    setPending(key, { op:'create', event:e });
    return `이렇게 추가할게요 👇\n${fmtEvent(e)}\n\n맞으면 "응", 아니면 "취소"라고 해주세요.`;
  }
  // update / delete : 대상 먼저 찾기
  if(!e.date && !e.target) return `어떤 일정을 ${intent.action==='delete'?'삭제':'수정'}할까요? 날짜나 제목을 알려주세요.`;
  const found = await gasCalSearch(e.date, e.target);
  if(!found.length) return '그 조건에 맞는 일정을 못 찾았어요. 🔍 날짜나 제목을 더 구체적으로 알려주세요.';
  if(found.length>1) return '해당 일정이 여러 개예요. 어떤 거예요? (시간이나 제목을 더 구체적으로)\n'+found.map(x=>`• ${x.start} ${x.title}`).join('\n');
  const t = found[0];
  if(intent.action==='delete'){
    setPending(key,{ op:'delete', id:t.id, summary:`${t.start} ${t.title}` });
    return `이 일정을 삭제할게요 👇\n🗑️ ${t.start} ${t.title}\n\n맞으면 "응", 아니면 "취소".`;
  }
  const changes = { title:e.title, date:e.date, start:e.start, end:e.end };
  setPending(key,{ op:'update', id:t.id, changes, summary:`${t.start} ${t.title}` });
  return `이 일정을 이렇게 바꿀게요 👇\n기존: ${t.start} ${t.title}\n변경: ${fmtEvent({ title:e.title||t.title, date:e.date, start:e.start, end:e.end, allDay:e.allDay })}\n\n맞으면 "응", 아니면 "취소".`;
}

async function execPending(p){
  if(p.op==='create'){
    const r = await gasCall({ action:'cal_create', title:p.event.title||'', date:p.event.date||'', start:p.event.start||'', end:p.event.end||'', allDay:p.event.allDay?'1':'' });
    return r?.result?.ok ? `✅ 추가했어요!\n${fmtEvent(p.event)}` : '⚠️ 추가에 실패했어요.';
  }
  if(p.op==='delete'){
    const r = await gasCall({ action:'cal_delete', id:p.id });
    return r?.result?.ok ? `🗑️ 삭제했어요: ${p.summary}` : '⚠️ 삭제에 실패했어요.';
  }
  if(p.op==='update'){
    const c = p.changes;
    const r = await gasCall({ action:'cal_update', id:p.id, title:c.title||'', date:c.date||'', start:c.start||'', end:c.end||'' });
    return r?.result?.ok ? `✏️ 수정했어요: ${p.summary}` : '⚠️ 수정에 실패했어요.';
  }
  return '⚠️ 알 수 없는 작업이에요.';
}

async function chat(utterance, history){
  const prompt =
`너는 준규 님의 다정하고 센스있는 업무 비서야.
[직전 대화] ${historyText(history)}
[이번 발화] "${utterance}"
규칙: 짧고 친근하게(2~3문장), 이모지 약간. 할 수 있는 일은 '구글 캘린더/지메일/드라이브/시트 조회'와 '일정 추가·수정·삭제'. 못 하는 요청이면 살짝 사과하고 할 수 있는 걸 안내. 인사면 반갑게.`;
  return (await askAI(prompt)).slice(0,980);
}

/* ===== GAS 호출 ===== */
async function gasCall(extra){
  const params = new URLSearchParams({ token:GAS_TOKEN, ...extra });
  const { data } = await axios.get(`${GAS_URL}?${params.toString()}`, { maxRedirects:5, timeout:20000 });
  return data;
}
async function gasCalSearch(date, keyword){
  const d = await gasCall({ action:'cal_search', date:date||'', keyword:keyword||'' });
  return d?.result || [];
}
async function fetchGas(intent){
  const extra = { action:intent.action };
  if(intent.action==='calendar'){ if(intent.from) extra.from=intent.from; if(intent.to) extra.to=intent.to; }
  else if(intent.action==='gmail'){ if(intent.gmailQuery) extra.q=intent.gmailQuery; }
  else if(intent.action==='drive'){ if(intent.driveQuery) extra.q=intent.driveQuery; }
  else if(intent.action==='sheet'){ if(intent.keyword) extra.keyword=intent.keyword; }
  return gasCall(extra);
}

async function summarize(utterance, gas, history){
  const prompt =
`너는 준규 님의 업무 비서야. 아래 구글 데이터를 보고 메신저 말풍선용 한국어 브리핑을 써.
[직전 대화] ${historyText(history)}
[이번 요청] "${utterance}"
[데이터(JSON)] ${JSON.stringify(gas).slice(0,7000)}
규칙: 핵심만, 항목은 줄바꿈으로, 이모지 약간, 인사말 없이 바로, 950자 이내.
- 메일이면 보낸사람/제목 위주, 안읽음(unread:true) 표시. 드라이브는 파일명/수정일 위주.
- 앞 대화를 이어받은 요청이면 그 맥락에 맞게. 결과가 비면 "해당 조건엔 없네요" + 어떤 조건으로 찾았는지 한 줄.`;
  return (await askAI(prompt)).slice(0,980);
}

/* ===== 출구 ===== */
async function sendKakao(callbackUrl, text){
  await axios.post(callbackUrl, { version:'2.0', template:{ outputs:[{ simpleText:{ text } }] } }, { timeout:10000 });
}
async function postSlack(url, text){
  await axios.post(url, { response_type:'ephemeral', text }, { timeout:10000 });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`server on :${PORT}`));

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
  if(p.op==='site_add') return `현장 추가 (진행상태: 제안)\n${fmtSite(p.site)}`;
  if(p.op==='site_status') return `현장 상태 변경: ${p.summary} → ${p.status}`;
  if(p.op==='update_many') return `${p.summary} 일정 일괄 수정`;
  if(p.op==='delete_many') return `${p.summary} 일정 일괄 삭제`;
  return '';
}
function addDays(ymd, n){ const d=new Date(ymd+'T00:00:00+09:00'); d.setDate(d.getDate()+n); return d.toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}); }
function fmtEvent(e){
  const t = e.title || '(제목 없음)';
  const cat = e.category ? `[${e.category}] ` : '';
  const base = e.allDay ? `📅 ${e.date} (종일) ${cat}${t}` : `📅 ${e.date} ${e.end?`${e.start}–${e.end}`:e.start} ${cat}${t}`;
  const ppl = [].concat(e.names||[], e.guests||[]);
  const g = ppl.length ? `\n👥 참석자: ${ppl.join(', ')}` : '';
  return base + g;
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
  // 대기 중 같은 종류의 수정(create/site) 요청이면 대기 일정에 병합
  const reviseSite = pending && pending.op==='site_add' && (action==='site_add' || action==='revise');
  const reviseCreate = pending && pending.op==='create' && (action==='revise' || action==='create' || action==='update');

  if(pending && action==='confirm'){ reply = await execPending(pending); clearPending(key); }
  else if(pending && action==='cancel'){ clearPending(key); reply = '알겠어요, 취소했어요. 😊'; }
  else if(reviseCreate){ reply = await revisePending(pending, intent, key); }
  else if(reviseSite){ reply = await reviseSitePending(pending, intent, key); }
  else if(pending && (action==='chat' || action==='calendar' || action==='gmail' || action==='drive' || action==='sheet')){
    // 대기 중인데 못 알아들은 말/엉뚱한 말 → 대기를 깨지 말고 다시 확인 요청
    reply = `방금 건 잘 못 알아들었어요. 🤔 아래 내용으로 진행할까요?\n\n${pendingSummary(pending)}\n\n"응"이면 진행, "취소"면 취소할게요.`;
  }
  else if(action==='create'||action==='update'||action==='delete'){ clearPending(key); reply = await prepareWrite({...intent, action, _utterance:utterance}, key); }
  else if(action==='site_add'||action==='site_status'){ clearPending(key); reply = await prepareSite({...intent, action}, key); }
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
사용자 답을 이렇게 분류해:
- 긍정(응/네/맞아/그래/좋아/ㅇㅇ/그대로/그대로 진행/그러니까 해줘/추가해줘/등록해줘/진행해) → action="confirm"
- 부정(아니/취소/안돼/하지마) → action="cancel"
- 위 대기 일정의 제목·시간·날짜·분류·참석자를 바꾸자는 요청(예: "이름을 ~로 바꿔서", "3시로", "외근으로", "박성범도 추가") → action="revise" 로 하고, event에 '바꿀 값만' 채워. (기존 일정을 새로 검색하는 update가 아님!)
- 위 일정과 전혀 무관한 새 요청 → 그 요청대로.`
    : '';
  const prompt =
`오늘은 ${today} (${weekday}), Asia/Seoul. 아래 맥락을 보고 '이번 발화'를 분석해 JSON 한 줄만 출력해.
${pendingBlock}
[직전 대화]
${historyText(history)}
[이번 발화]
"${utterance}"

형식: {"action":"calendar|gmail|drive|sheet|chat|create|update|delete|confirm|cancel|revise|site_add|site_status","from":null,"to":null,"gmailQuery":null,"driveName":null,"driveQuery":null,"keyword":null,"event":{"title":null,"date":"yyyy-mm-dd|null","start":"HH:mm|null","end":"HH:mm|null","allDay":false,"category":null,"guests":[],"names":[],"findDate":null,"findDateTo":null,"target":null},"site":{"address":null,"vendor":null,"note":null,"spaceType":null,"area":null,"firstContact":null,"quoteDate":null,"startDate":null,"firstSurvey":null,"installDate":null,"endDate":null,"proposer":null,"fieldMgr":null,"custName":null,"custTel":null,"siteLead":null,"siteLeadTel":null,"quote":null,"saleMonth":null,"orderCode":null,"query":null,"status":null}}

[분류]
- 일정 조회→calendar, 메일→gmail, 드라이브/파일→drive, 시트→sheet
- 일정 추가→create, 일정 수정/변경→update, 일정 삭제/취소→delete
- 인사·잡담·불가능한 요청→chat
[맥락 이어받기] "그중에서/그건/그럼 그건/PDF로 된 거" 처럼 앞을 가리키면 직전 대화의 대상·조건을 이어받아 채워.
[calendar] from/to 날짜. "오늘"→from=to=오늘, 하루면 from=to 동일, "이번주/다음주/주말/이번달"은 범위, 없으면 null.
[gmail] gmailQuery=Gmail검색식 (from:이름 / is:unread / has:attachment / newer_than:3d). 막연하면 null.
[drive] driveName=파일명에서 찾을 핵심 단어/문구(폴더 위치 무시, 부분일치). 예) "스마트홈 표준계약서 찾아줘"→driveName="표준계약서". 파일종류까지 좁혀야 할 때만 driveQuery=Drive검색식(mimeType 등). 보통은 driveName만 채우고 driveQuery는 null.
[sheet] keyword=시트 이름 핵심 단어.
[현장리스트 시트] '현장리스트'에 현장을 다루면:
- 새 현장 추가 → action="site_add". site에 말한 항목만 채워: address(현장주소·필수), vendor(인테리어 업체명), proposer(아카라 영업담당), fieldMgr(현장담당 정), spaceType(유형: 아파트/단독주택/오피스/상가/공공기관), area(공급면적 평수 숫자), firstContact(인입일=최초접촉일 yyyy-mm-dd), quoteDate(가견적 제안일 yyyy-mm-dd), startDate(계약일 yyyy-mm-dd), firstSurvey(실사일 yyyy-mm-dd), installDate(조명설치예정일 yyyy-mm-dd), custName/custTel(고객성함·연락처), siteLead/siteLeadTel(현장소장·연락처), note(특이사항). 진행상태는 서버가 자동(제안)이니 넣지 마.
- 현장 상태 변경 → action="site_status". site.query=현장 찾을 말(주소+업체명, 예: "테라디자인 베른"), site.status=제안|진행중|완료|취소.
[중요·날짜기준] '오늘/내일/어제/모레/이번주/다음주/요일'은 모두 위에 적힌 오늘 날짜(Asia/Seoul) 기준으로 정확히 환산해.
[event] create/update/delete일 때: title=제목, start/end="HH:mm"(24시간, 없으면 null), "종일"이면 allDay=true. category=분류(내근/외근/손님/의사결정회의/공지, "기본"이면 "기본", 없으면 null). target=기존 일정 찾을 제목 키워드.
  - date = '새로 바꿀(또는 추가할) 날짜' yyyy-mm-dd.
  - findDate = '기존 일정이 현재 있는 날짜' yyyy-mm-dd (update/delete에서 일정을 찾을 날짜). findDateTo = 찾을 범위 끝(여러 날 뒤져야 할 때).
  - 예) "내일 잡은 베른 감리를 수요일로 옮겨줘" → action=update, target="베른", findDate=(내일 날짜), date=(이번주 수요일 날짜).
  - 찾을 날짜가 분명치 않으면 findDate=오늘, findDateTo=오늘+14일 로 넓게.
[되물음 이어받기] 비서가 직전에 일정의 빠진 정보(시간/분류/참석자 등)를 되물었다면, 사용자의 짧은 답을 직전 일정 요청에 합쳐 create로 완성해.
[참석자] 일정에 동료를 부르면:
- title(제목)에는 절대 사람 이름을 넣지 마. 제목은 순수 일정명만.
- 이메일 주소가 있으면 guests 배열에 그 이메일을 넣어. (예: "sungbum@aqara.kr 초대" -> guests:["sungbum@aqara.kr"])
- 한글 이름으로 부르면 names 배열에 그 이름을 넣어. (예: "박성범도 불러" -> names:["박성범"]) 이메일은 추측하지 마. 회사 디렉터리에서 서버가 변환해.
- "나도"/"전준규도" 처럼 본인을 포함하라는 말이 있으면 guests에 "jungyu@aqara.kr" 포함.
해당 없는 필드는 null. 설명·코드블록 없이 JSON 한 줄만.`;
  try{
    const txt = (await askAI(prompt)).replace(/```json|```/g,'').trim();
    const o = JSON.parse(txt);
    const ok = ['calendar','gmail','drive','sheet','chat','create','update','delete','confirm','cancel','revise','site_add','site_status'];
    const c = v => (v && v!=='null' ? v : null);
    const ev = o.event || {};
    return {
      action: ok.includes(o.action)?o.action:'chat',
      from:c(o.from), to:c(o.to), gmailQuery:c(o.gmailQuery), driveName:c(o.driveName), driveQuery:c(o.driveQuery), keyword:c(o.keyword),
      event:{ title:c(ev.title), date:c(ev.date), start:c(ev.start), end:c(ev.end), allDay:!!ev.allDay, category:c(ev.category), guests:Array.isArray(ev.guests)?ev.guests.filter(x=>x&&x.indexOf('@')!==-1):[], names:Array.isArray(ev.names)?ev.names.filter(Boolean):[], findDate:c(ev.findDate), findDateTo:c(ev.findDateTo), target:c(ev.target) },
      site: (function(st){ st=st||{}; const o={}; ['address','vendor','note','spaceType','area','firstContact','quoteDate','startDate','firstSurvey','installDate','endDate','proposer','fieldMgr','custName','custTel','siteLead','siteLeadTel','quote','saleMonth','orderCode','query','status'].forEach(k=>{ o[k]=c(st[k]); }); return o; })(o.site),
    };
  }catch{ return { action:'chat', event:{}, site:{} }; }
}

/* 확인 대기 중인 일정에 '바꿀 값만' 반영하고 다시 확인 (검색 안 함) */
async function revisePending(pending, intent, key){
  if(pending.op !== 'create'){
    // 수정/삭제 대기였던 경우는 그냥 새로 처리
    clearPending(key);
    return prepareWrite(intent, key);
  }
  const e = pending.event || {};
  const n = intent.event || {};
  const merged = {
    title:   n.title   != null ? n.title   : e.title,
    date:    n.date    != null ? n.date    : e.date,
    start:   n.start   != null ? n.start   : e.start,
    end:     n.end     != null ? n.end     : e.end,
    allDay:  (n.start!=null||n.end!=null) ? false : (n.allDay || e.allDay),
    category:n.category!= null ? n.category : e.category,
    guests:  (n.guests && n.guests.length) ? Array.from(new Set([...(e.guests||[]), ...n.guests])) : (e.guests||[]),
    names:   (n.names  && n.names.length)  ? Array.from(new Set([...(e.names||[]),  ...n.names]))  : (e.names||[]),
  };
  return prepareWrite({ action:'create', event: merged }, key);
}

/* ===== 현장리스트 쓰기 준비/실행 ===== */
function fmtSite(st){
  const L = [];
  const add=(label,v)=>{ if(v) L.push(`• ${label}: ${v}`); };
  add('현장주소', st.address); add('유형', st.spaceType); add('공급면적(평)', st.area);
  add('인테리어 업체명', st.vendor);
  add('아카라 영업담당', st.proposer); add('현장담당(정)', st.fieldMgr);
  add('인입일', st.firstContact); add('가견적 제안일', st.quoteDate);
  add('계약일', st.startDate); add('실사일', st.firstSurvey); add('설치예정일', st.installDate);
  add('고객성함', st.custName); add('고객연락처', st.custTel);
  add('현장소장', st.siteLead); add('소장 연락처', st.siteLeadTel);
  add('특이사항', st.note);
  return L.join('\n');
}

async function reviseSitePending(pending, intent, key){
  const e = pending.site || {};
  const n = intent.site || {};
  const merged = Object.assign({}, e);
  Object.keys(n).forEach(k=>{ if(n[k]!=null) merged[k]=n[k]; });
  return prepareSite({ action:'site_add', site: merged }, key);
}

async function prepareSite(intent, key){
  const st = intent.site || {};
  if(intent.action==='site_add'){
    if(!st.address) return '새 현장은 현장주소부터 알려주세요. 📍 (주소를 넣으면 진행상태는 자동으로 "제안"이 돼요)';
    setPending(key, { op:'site_add', site: st });
    return `이렇게 맨 위에 추가할게요 👇\n📋 현장리스트 (진행상태: 제안)\n${fmtSite(st)}\n\n맞으면 "응", 아니면 "취소".`;
  }
  // site_status : 현장 찾기
  if(!st.query) return '어떤 현장의 상태를 바꿀까요? 주소나 업체명으로 알려주세요. (예: "테라디자인 베른 현장")';
  if(!st.status) return '어떤 상태로 바꿀까요? 제안 / 진행중 / 완료 / 취소 중에 알려주세요.';
  const found = await gasCall({ action:'site_find', q: st.query });
  const list = found?.result || [];
  if(!list.length) return `'${st.query}'에 맞는 현장을 못 찾았어요. 🔍 주소나 업체명을 더 구체적으로 알려주세요.`;
  if(list.length>1) return '해당 현장이 여러 개예요. 더 구체적으로 알려주세요.\n'+list.map(x=>`• ${x.code||'(코드없음)'} ${x.address} / ${x.vendor} [${x.status}]`).join('\n');
  const t = list[0];
  setPending(key, { op:'site_status', row:t.row, status:st.status, summary:`${t.address} / ${t.vendor}` });
  let extra = (st.status==='진행중'||st.status==='완료') && !t.code ? '\n(현장코드가 자동 생성돼요)' : '';
  return `이 현장 상태를 바꿀게요 👇\n📋 ${t.address} / ${t.vendor}\n${t.status} → ${st.status}${extra}\n\n맞으면 "응", 아니면 "취소".`;
}

/* ===== 쓰기 준비 (확인 메시지 만들고 대기에 저장) ===== */
async function prepareWrite(intent, key){
  const e = intent.event || {};
  if(intent.action==='create'){
    if(!e.title) return '무슨 일정을 추가할까요? 제목을 알려주세요. 📝';
    if(!e.date)  return `'${e.title}' 일정을 며칠에 추가할까요? 📅`;
    if(!e.allDay && !e.start) return `'${e.title}' (${e.date}) — 몇 시로 잡을까요? ⏰ 종일로 하려면 "종일"이라고 해주세요.`;
    if(!e.category) return `'${e.title}' (${e.date}${e.start?' '+e.start:''}) — 어디로 분류할까요? 📂\n내근 / 외근 / 손님 / 의사결정회의 / 공지·기타 / 기본 중에 골라주세요.`;
    setPending(key, { op:'create', event:e });
    return `이렇게 추가할게요 👇\n${fmtEvent(e)}\n\n맞으면 "응", 아니면 "취소"라고 해주세요.`;
  }
  // update / delete : 대상 먼저 찾기 (findDate=찾을 날짜, 없으면 오늘~+14일 범위)
  if(!e.findDate && !e.date && !e.target) return `어떤 일정을 ${intent.action==='delete'?'삭제':'수정'}할까요? 날짜나 제목을 알려주세요.`;
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Seoul' });
  const fromDate = e.findDate || todayStr;
  const toDate = e.findDateTo || e.findDate || addDays(fromDate, 14); // 찾을 날짜 없으면 2주 범위
  const found = await gasCalSearch(fromDate, e.target, toDate);
  if(!found.length) return `'${e.target||''}' 일정을 ${e.findDate?e.findDate+'에서':'가까운 날짜에서'} 못 찾았어요. 🔍 일정이 며칠에 있는지 알려주시면 정확해요.`;
  if(found.length>1){
    // "둘 다 / 전부 / 모두 / 다" 같은 일괄 의사가 있으면 한 번에 처리
    const wantAll = /둘\s*다|전부|모두|다\s*(변경|바꿔|삭제|지워)|all/i.test(intent._utterance||'');
    if(wantAll){
      const items = found.map(x=>({ id:x.id, calId:x.calId }));
      const listTxt = found.map(x=>`• ${x.start} ${x.title}`).join('\n');
      if(intent.action==='delete'){
        setPending(key,{ op:'delete_many', items, summary:`${found.length}개`, listTxt });
        return `아래 ${found.length}개를 전부 삭제할게요 👇\n${listTxt}\n\n맞으면 "응", 아니면 "취소".`;
      }
      const changes = { title:e.title, date:e.date, start:e.start, end:e.end };
      setPending(key,{ op:'update_many', items, changes, summary:`${found.length}개`, listTxt });
      return `아래 ${found.length}개를 전부 이렇게 바꿀게요 👇\n${listTxt}\n→ 변경: ${fmtEvent({ title:e.title, date:e.date, start:e.start, end:e.end, allDay:e.allDay })}\n\n맞으면 "응", 아니면 "취소".`;
    }
    return '해당 일정이 여러 개예요. 어떤 거예요? (날짜·제목을 더 구체적으로, 또는 "둘 다 변경/삭제"라고 말해주세요)\n'+found.map(x=>`• ${x.start} ${x.title}`).join('\n');
  }
  const t = found[0];
  if(intent.action==='delete'){
    setPending(key,{ op:'delete', id:t.id, calId:t.calId, summary:`${t.start} ${t.title}` });
    return `이 일정을 삭제할게요 👇\n🗑️ ${t.start} ${t.title}\n\n맞으면 "응", 아니면 "취소".`;
  }
  const changes = { title:e.title, date:e.date, start:e.start, end:e.end };
  setPending(key,{ op:'update', id:t.id, calId:t.calId, changes, summary:`${t.start} ${t.title}` });
  return `이 일정을 이렇게 바꿀게요 👇\n기존: ${t.start} ${t.title}\n변경: ${fmtEvent({ title:e.title||t.title, date:e.date, start:e.start, end:e.end, allDay:e.allDay })}\n\n맞으면 "응", 아니면 "취소".`;
}

async function execPending(p){
  if(p.op==='create'){
    const r = await gasCall({ action:'cal_create', title:p.event.title||'', date:p.event.date||'', start:p.event.start||'', end:p.event.end||'', allDay:p.event.allDay?'1':'', category:p.event.category||'', guests:(p.event.guests||[]).join(','), names:(p.event.names||[]).join(',') });
    const res = r?.result;
    if(!res?.ok) return '⚠️ 추가에 실패했어요.';
    const ev2 = {...p.event, guests: res.guests||p.event.guests, names: []};
    let msg = `✅ 추가했어요!\n${fmtEvent(ev2)}`;
    const probs = [];
    if(res.notFound?.length) probs.push(`'${res.notFound.join(", ")}'은(는) 디렉터리에서 못 찾았어요`);
    if(res.ambiguous?.length) probs.push(`'${res.ambiguous.join(", ")}'은(는) 동명이인이 있어 못 정했어요`);
    if(probs.length) msg += `\n⚠️ ${probs.join(' / ')} — 이메일로 알려주면 추가할게요.`;
    return msg;
  }
  if(p.op==='delete'){
    const r = await gasCall({ action:'cal_delete', id:p.id, calId:p.calId||'' });
    return r?.result?.ok ? `🗑️ 삭제했어요: ${p.summary}` : '⚠️ 삭제에 실패했어요.';
  }
  if(p.op==='site_add'){
    const r = await gasCall(Object.assign({ action:'site_add' }, p.site));
    return r?.result?.ok ? `✅ 현장을 추가했어요! (진행상태: 제안)\n${fmtSite(p.site)}` : '⚠️ 현장 추가에 실패했어요.';
  }
  if(p.op==='site_status'){
    const r = await gasCall({ action:'site_status', row:p.row, status:p.status });
    const res = r?.result;
    if(!res?.ok) return '⚠️ 상태 변경에 실패했어요.';
    let msg = `✅ 상태를 "${res.status}"로 바꿨어요: ${p.summary}`;
    if(res.code) msg += `\n🏷️ 현장코드 자동 생성: ${res.code}`;
    return msg;
  }
  if(p.op==='update_many'){
    const c = p.changes;
    const r = await gasCall({ action:'cal_update_many', items: JSON.stringify(p.items), title:c.title||'', date:c.date||'', start:c.start||'', end:c.end||'' });
    return r?.result?.ok ? `✏️ ${r.result.count}개 일정을 수정했어요.` : '⚠️ 일괄 수정에 실패했어요.';
  }
  if(p.op==='delete_many'){
    const r = await gasCall({ action:'cal_delete_many', items: JSON.stringify(p.items) });
    return r?.result?.ok ? `🗑️ ${r.result.count}개 일정을 삭제했어요.` : '⚠️ 일괄 삭제에 실패했어요.';
  }
  if(p.op==='update'){
    const c = p.changes;
    const r = await gasCall({ action:'cal_update', id:p.id, calId:p.calId||'', title:c.title||'', date:c.date||'', start:c.start||'', end:c.end||'' });
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
  const clean = {}; Object.keys(extra||{}).forEach(k=>{ if(extra[k]!=null) clean[k]=extra[k]; });
  const params = new URLSearchParams({ token:GAS_TOKEN, ...clean });
  const { data } = await axios.get(`${GAS_URL}?${params.toString()}`, { maxRedirects:5, timeout:20000 });
  return data;
}
async function gasCalSearch(date, keyword, dateTo){
  const d = await gasCall({ action:'cal_search', date:date||'', dateTo:dateTo||'', keyword:keyword||'' });
  return d?.result || [];
}
async function fetchGas(intent){
  const extra = { action:intent.action };
  if(intent.action==='calendar'){ if(intent.from) extra.from=intent.from; if(intent.to) extra.to=intent.to; }
  else if(intent.action==='gmail'){ if(intent.gmailQuery) extra.q=intent.gmailQuery; }
  else if(intent.action==='drive'){ if(intent.driveName) extra.name=intent.driveName; if(intent.driveQuery) extra.q=intent.driveQuery; }
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
- 드라이브/시트 결과는 파일명·수정일과 함께 url을 그대로 적어 바로 열 수 있게 해.
- 앞 대화를 이어받은 요청이면 그 맥락에 맞게.
- 결과 배열이 비어 있으면 둘러대지 말고 "드라이브 전체를 'XX'로 찾아봤는데 그런 파일은 없네요 🔍"처럼 솔직하게. "제가 직접 찾아드릴게요", "링크를 찾아 보내드릴게요" 같은 지키지 못할 약속은 절대 하지 마.`;
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

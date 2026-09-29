/*** 구글챗 비서 (Gemini · 검색 · 대화기억 · 캘린더 쓰기) ********
 * 읽기: 일정/메일/드라이브/시트 조회
 * 쓰기: 일정 추가·수정·삭제 (실행 전 "이렇게 할게요?" 확인)
 * 기억/대기작업: 서버 메모리 (재시작 시 초기화)
 * Render 환경변수: GAS_URL, GAS_TOKEN, GEMINI_API_KEY, (선택) GEMINI_MODEL
 * [2026-09-29a] 현장 공정 날짜는 체크리스트 검색·확인·단일 날짜 수정으로 처리.
 * [2026-09-29b] GAS 연결 진단·현장리스트 표현 보완·선택형 구글챗 처리 중 표시.
 * [2026-09-29c] 중복 확인 방지·같은 현장의 여러 공정 한 번 확인·응답 유실 시 현재 날짜 재조회.
 * [2026-09-29d] '3일 뒤/후' 공정 날짜·띄어 쓴 현장 리스트 인식 보완, 카카오톡 연결 제거.
 * [2026-09-29e] A열 현장코드는 수기 관리. 상태 변경 시 자동 발급 안내 제거.
 * [2026-09-29f] 여러 공정 검색·재조회를 한 번에 처리하고 읽기 재시도는 기존 제한시간 안에서만 수행.
 *
 * [2026-08 정리] 사용되지 않던 현장 필드 quote/saleMonth/orderCode/endDate 제거.
 *   - 감리시트(본진)에 해당 칸이 없어서 파서가 뽑아도 버려지던 값들.
 *   - fmtSite / SITE_FIELD_KEYS / ASK_FIELDS 에는 원래부터 없었음 (파서에만 남아있던 잔재).
 *
 * [2026-08-21] 감리시트 N·O에 '현장실장'·'실장연락처' 2열 추가 → siteMgr/siteMgrTel 지원.
 *   감리시트는 31열이 됨. 열 위치는 GAS가 2행 헤더 문구로 자동 인식하므로,
 *   여기(비서)에서는 열 번호를 몰라도 되고 필드명만 GAS와 맞추면 된다.
 *   되묻기(ASK_FIELDS)에는 넣지 않았다 — 기존 siteLead(현장소장)와 동일하게
 *   사용자가 말하면 받아 적되 먼저 캐묻지는 않는다.
 *********************************************************************/
import express from 'express';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createHash } from 'node:crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const GAS_URL   = process.env.GAS_URL;
const GAS_TOKEN = process.env.GAS_TOKEN;
const BOT_VERSION = '2026-09-29f';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

/* ===== 대화 기억 + 대기 작업 (서버 메모리) ===== */
const HISTORY = new Map();
const PENDING = new Map();
const ASSISTANT_QUEUES = new Map();
const ASSISTANT_REQUESTS = new Map();
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
  if(p.op==='site_schedule') return `체크리스트 공정일 변경: ${p.summary}\n${p.phase}: ${p.oldDate || '미입력'} → ${p.date}`;
  if(p.op==='site_schedule_many') return `체크리스트 공정일 변경: ${p.summary}\n${p.items.map(item=>`${item.phase}: ${item.oldDate || '미입력'} → ${item.date}`).join('\n')}`;
  if(p.op==='site_schedule_ask') return `체크리스트 공정일 변경: ${p.query || '(현장 미지정)'} / ${p.phase || '(공정 미지정)'} / ${p.date || '(날짜 미지정)'}`;
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

/* ===== 구글 챗 ===== */
app.post('/gchat', async (req,res)=>{
  const ev = req.body || {};
  const key = ev.user?.name || ev.message?.sender?.name || null;
  const receipt = {pending:getPending(key)};
  const progressEnabled = process.env.GCHAT_PROGRESS_ENABLED === 'true';
  if(progressEnabled && !await verifyGoogleChatRequest(req)) return res.status(401).json({error:'unauthorized'});
  if(ev.type === 'REMOVED_FROM_SPACE') return res.json({});
  if(ev.type!=='MESSAGE') return res.json({ text:'안녕하세요! 일정·메일·드라이브·시트 조회와 일정 추가·수정·삭제를 도와드려요. 😊' });
  const text = (ev.message?.text||'').replace(/^@\S+\s*/,'');
  if(progressEnabled) return respondGoogleChatProgress(ev, text, key, res, receipt);
  return respondGoogleChatSync(ev, text, key, res, receipt);
});

// 진행 표시는 Chat API 메시지다. 인증 설정 전에는 기존 동기 응답을 그대로 사용한다.
const GCHAT_REQUESTS = new Map();
const GCHAT_SYNC_REQUESTS = new Map();
const GCHAT_USER_QUEUES = new Map();
let gchatVerifier;
let gchatAuthClient;
let gchatMissingCredentialsLogged = false;
async function respondGoogleChatSync(ev, text, key, res, receipt = {pending:getPending(key)}){
  const source = ev.message?.name;
  const id = typeof source === 'string' && /^spaces\/[^/]+\/messages\/[^/]+$/.test(source) ? source : null;
  for(const [name, entry] of GCHAT_SYNC_REQUESTS){
    if(entry.done && Date.now()-entry.ts > 30*60*1000) GCHAT_SYNC_REQUESTS.delete(name);
  }
  // Chat의 같은 이벤트 재전송은 조회·수정·확인카드를 다시 만들지 않는다.
  if(id && GCHAT_SYNC_REQUESTS.has(id)) return res.json({});
  const entry = {done:false,ts:Date.now()};
  if(id) GCHAT_SYNC_REQUESTS.set(id,entry);
  try{
    const reply = await handleAsync(text,key,receipt);
    return res.json(reply == null ? {} : {text:reply});
  }catch(e){
    console.error('[gchat] request processing failed');
    return res.json({text:'⚠️ 처리 결과를 확인하지 못했어요. 변경 요청이었다면 현재 내용을 확인해 주세요.'});
  }finally{ entry.done = true; entry.ts = Date.now(); }
}
async function gchatWithin(promise, milliseconds){
  let timer;
  try{
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer = setTimeout(()=>reject(new Error('Google Chat authentication timeout')),milliseconds);
    })]);
  }finally{ clearTimeout(timer); }
}
async function verifyGoogleChatRequest(req){
  const authorization = req.headers?.authorization || '';
  const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if(!token) return false;
  try{
    gchatVerifier ||= new OAuth2Client();
    const ticket = await gchatWithin(gchatVerifier.verifyIdToken({idToken:token,
      audience:process.env.GCHAT_AUDIENCE || 'https://kakaobiseo.onrender.com/gchat'}),5000);
    const payload = ticket.getPayload();
    return payload?.email_verified === true && payload.email === 'chat@system.gserviceaccount.com';
  }catch{ return false; }
}
function gchatLogFailure(stage, error){
  // 인증 헤더·키·사용자 문장이 담길 수 있는 SDK 오류 원문은 기록하지 않는다.
  const status = Number(error?.response?.status);
  console.warn(`[gchat-progress] ${stage}${Number.isInteger(status) && status > 0 ? ` (HTTP ${status})` : ''}`);
}
async function gchatAccessToken(){
  if(!process.env.GOOGLE_APPLICATION_CREDENTIALS){
    if(!gchatMissingCredentialsLogged){
      console.warn('[gchat-progress] GOOGLE_APPLICATION_CREDENTIALS 미설정 — 기존 동기 응답 사용');
      gchatMissingCredentialsLogged = true;
    }
    return null;
  }
  try{
    gchatAuthClient ||= new GoogleAuth({scopes:['https://www.googleapis.com/auth/chat.bot']}).getClient();
    const client = await gchatAuthClient;
    const result = await client.getAccessToken();
    const token = typeof result === 'string' ? result : result?.token;
    if(!token) throw new Error('missing access token');
    return token;
  }catch(error){ gchatAuthClient = undefined; throw error; }
}
async function gchatApi(method, resource, body, params){
  let token;
  try{ token = await gchatWithin(gchatAccessToken(),5000); }
  catch{
    const error = new Error('Google Chat credentials unavailable');
    error.gchatBeforeSend = true;
    throw error;
  }
  if(!token) return null;
  return axios.request({method,url:`https://chat.googleapis.com/v1/${resource}`,
    headers:{Authorization:`Bearer ${token}`}, data:body, params, timeout:6000});
}
function queueGoogleChatUser(key, work){
  const previous = GCHAT_USER_QUEUES.get(key) || Promise.resolve();
  const job = previous.catch(()=>{}).then(work);
  GCHAT_USER_QUEUES.set(key, job);
  job.finally(()=>{ if(GCHAT_USER_QUEUES.get(key) === job) GCHAT_USER_QUEUES.delete(key); }).catch(()=>{});
  return job;
}
async function finishGoogleChatProgress(messageName, reply, space, messageId){
  if(reply == null){
    try{ return !!await gchatApi('DELETE',messageName); }
    catch(error){
      if(error?.response?.status === 404) return true;
      gchatLogFailure('중복 요청의 진행 메시지 정리 실패',error);
      try{ return !!await gchatApi('PATCH',messageName,{text:'같은 요청이 이미 접수되어 기존 요청의 결과로 안내드릴게요.'},{updateMask:'text'}); }
      catch{ return false; }
    }
  }
  for(let attempt=0; attempt<2; attempt++){
    try{
      const result = await gchatApi('PATCH', messageName, {text:reply}, {updateMask:'text'});
      if(result) return true;
    }catch(error){ gchatLogFailure('답변 메시지 갱신 실패', error); }
  }
  // 답변 전달만 다시 시도한다. 현장/일정 처리 함수를 재실행하지 않는다.
  try{
    const result = await gchatApi('POST', `${space}/messages`, {text:reply}, {messageId:`${messageId}-result`});
    if(result){
      // 최종 답변을 별도로 보냈다면 남은 '확인 중' 메시지를 정리한다.
      try{ await gchatApi('DELETE',messageName); }
      catch(error){ if(error?.response?.status !== 404) gchatLogFailure('최종 답변 전달됨 — 이전 진행 메시지 정리 실패',error); }
      return true;
    }
  }catch(error){ gchatLogFailure('최종 답변 별도 전달 실패 — 요청을 자동 재실행하지 않음', error); }
  return false;
}
async function respondGoogleChatProgress(ev, text, key, res, receipt = {pending:getPending(key)}){
  const space = ev.space?.name || ev.message?.space?.name;
  const source = ev.message?.name;
  if(typeof space !== 'string' || !/^spaces\/[A-Za-z0-9_-]+$/.test(space) ||
    typeof source !== 'string' || !source.startsWith(`${space}/messages/`) ||
    !/^[A-Za-z0-9_.-]+$/.test(source.slice(`${space}/messages/`.length)) ||
    typeof key !== 'string' || !/^users\/[A-Za-z0-9_-]+$/.test(key)){
    return res.json({text:'대화 정보를 확인하지 못했어요. 비서와의 개인 대화에서 다시 요청해 주세요.'});
  }
  for(const [id, entry] of GCHAT_REQUESTS){
    if(entry.done && Date.now()-entry.ts > 30*60*1000) GCHAT_REQUESTS.delete(id);
  }
  const duplicate = GCHAT_REQUESTS.get(source);
  if(duplicate){
    if(duplicate.done && duplicate.progress && duplicate.deliveryFailed && !duplicate.deliveryRecoveryAttempted){
      duplicate.deliveryRecoveryAttempted = true;
      res.json({});
      // Google의 재전달은 업무 재실행이 아니라 저장된 답변의 전달 복구에만 쓴다.
      duplicate.deliveryFailed = !await finishGoogleChatProgress(duplicate.messageName,duplicate.reply,space,duplicate.messageId);
      return;
    }
    if(duplicate.acknowledged) return res.json({});
    await duplicate.prepared;
    if(duplicate.acknowledged) return res.json({});
    const reply = await duplicate.job;
    return res.json(duplicate.acknowledged || reply == null ? {} : {text:reply});
  }
  const messageId = 'client-' + createHash('sha256').update(source).digest('hex').slice(0,40);
  const messageName = `${space}/messages/${messageId}`;
  const entry = {ts:Date.now(),done:false,progress:false,acknowledged:false,job:null,prepared:null,
    reply:'',deliveryFailed:false,deliveryRecoveryAttempted:false,messageName,messageId};
  GCHAT_REQUESTS.set(source,entry);
  // 앞 요청의 처리를 기다리는 요청도 먼저 접수 표시를 보낸다. 업무 처리 순서는 아래 큐가 지킨다.
  entry.prepared = (async()=>{
    let uncertainProgress = false;
    try{
      const created = await gchatApi('POST',`${space}/messages`,{text:'✍️ 요청을 확인하고 있어요. 잠시만 기다려 주세요…'},{messageId});
      if(created){
        entry.progress = true;
        entry.acknowledged = true;
        res.json({});
      }
    }catch(error){
      if(error?.response?.status === 409){
        // 재시작 뒤에도 같은 요청으로 이미 만든 메시지가 있으면 쓰기를 반복하지 않는다.
        const reply = '이 요청은 이미 접수된 기록이 있어요. 시트나 캘린더의 현재 내용을 확인한 뒤 필요하면 새로 요청해 주세요.';
        entry.acknowledged = true;
        res.json({text:reply});
        return {alreadyReceived:reply};
      }
      uncertainProgress = !error?.response && !error?.gchatBeforeSend;
      gchatLogFailure('진행 표시를 보내지 못해 기존 응답 방식으로 처리',error);
    }
    return {uncertainProgress};
  })();
  entry.job = queueGoogleChatUser(key, async()=>{
    try{
      const preparation = await entry.prepared;
      if(preparation.alreadyReceived) return preparation.alreadyReceived;
      let reply;
      try{ reply = await handleAsync(text,key,receipt); }
      catch(error){
        gchatLogFailure('요청 처리 실패',error);
        reply = '⚠️ 처리를 완료했는지 확인하지 못했어요. 변경 요청이었다면 시트나 캘린더의 현재 내용을 확인해 주세요.';
      }
      entry.reply = reply;
      if(entry.progress) entry.deliveryFailed = !await finishGoogleChatProgress(messageName,reply,space,messageId);
      else if(preparation.uncertainProgress){
        if(reply == null){
          await finishGoogleChatProgress(messageName,reply,space,messageId);
          return null;
        }
        // 생성 응답만 유실됐을 수 있다. 남아 있는 진행 메시지를 정리하되 작업은 다시 하지 않는다.
        try{
          const updated = await gchatApi('PATCH',messageName,{text:reply},{updateMask:'text'});
          if(updated){ entry.progress = true; entry.acknowledged = true; res.json({}); }
        }catch(error){ gchatLogFailure('진행 메시지 확인 실패 — 동기 답변 사용',error); }
      }
      return reply;
    }finally{ entry.done = true; entry.ts = Date.now(); }
  });
  const reply = await entry.job;
  if(!entry.acknowledged){ entry.acknowledged = true; return res.json(reply == null ? {} : {text:reply}); }
}

/* ===== 공통 두뇌 ===== */
function handleAsync(utterance, key, receipt = {pending:getPending(key)}){
  if(!key) return handleAsyncInOrder(utterance,key,receipt);
  const normalized = String(utterance || '').trim().replace(/\s+/g,' ');
  const previousRequest = ASSISTANT_REQUESTS.get(key);
  const currentPending = getPending(key);
  if(previousRequest?.text === normalized && (!previousRequest.done ||
    (previousRequest.pending && previousRequest.pending === currentPending))) return Promise.resolve(null);
  for(const [user, request] of ASSISTANT_REQUESTS){
    if(request.done && Date.now()-request.ts > 30*60*1000) ASSISTANT_REQUESTS.delete(user);
  }
  const entry = {text:normalized,done:false,pending:null,ts:Date.now()};
  ASSISTANT_REQUESTS.set(key,entry);
  const before = ASSISTANT_QUEUES.get(key) || Promise.resolve();
  const job = before.catch(()=>{}).then(async()=>{
    const pendingBefore = getPending(key);
    try{
      const reply = await handleAsyncInOrder(utterance,key,receipt);
      const pendingAfter = getPending(key);
      // 확인 대기만 재사용한다. 입력을 되묻는 중에는 같은 짧은 답도 다음 칸에 쓸 수 있다.
      if(pendingAfter && pendingAfter !== pendingBefore &&
        !['site_ask','site_schedule_ask'].includes(pendingAfter.op)) entry.pending = pendingAfter;
      return reply;
    }finally{ entry.done = true; entry.ts = Date.now(); }
  });
  ASSISTANT_QUEUES.set(key,job);
  job.finally(()=>{ if(ASSISTANT_QUEUES.get(key) === job) ASSISTANT_QUEUES.delete(key); }).catch(()=>{});
  return job;
}
async function handleAsyncInOrder(utterance, key, receipt){
  if(/^(?:비서\s*)?(?:연결|배포)\s*(?:확인|진단)(?:해줘|해\s*줘)?[.!?\s]*$/.test(String(utterance || '').trim())) return diagnoseGasConnection();
  const history = getHistory(key);
  const pending = getPending(key);

  // 현장 추가 대화(되묻기 site_ask + 확인카드 site_add)는 전용 처리로 (인텐트 분류 생략)
  if(pending && (pending.op==='site_ask' || pending.op==='site_add')){
    if(pending.op==='site_add' && SITE_CONFIRM_RE.test(String(utterance).trim()) && receipt && receipt.pending !== pending){
      return '확인할 내용이 바뀌었어요. 위의 최신 변경 목록을 확인한 뒤 "응"이라고 해주세요.';
    }
    const reply = await handleSiteFlow(pending, utterance, key);
    pushHistory(key,'user',utterance);
    pushHistory(key,'assistant',reply);
    return reply;
  }

  // 공정 날짜는 구글 캘린더 검색으로 빠지지 않도록 먼저 명확한 요청을 처리한다.
  const intent = parseSiteScheduleCommand(utterance, pending) || await parseIntent(utterance, history, pending);
  let action = intent.action;
  if(!pending && (action==='confirm'||action==='cancel')) action='chat';

  let reply;
  // 대기 중 같은 종류의 수정 요청이면 대기 일정에 병합 (현장 대기는 상단 handleSiteFlow에서 처리됨)
  const reviseCreate = pending && pending.op==='create' && (action==='revise' || action==='create' || action==='update');

  if(pending && action==='confirm'){
    if(receipt && receipt.pending !== pending) return '확인할 내용이 바뀌었어요. 위의 최신 변경 목록을 확인한 뒤 "응"이라고 해주세요.';
    clearPending(key); // 확인 메시지가 겹쳐도 같은 대기를 두 번 실행하지 않는다.
    reply = await execPending(pending);
  }
  else if(pending && action==='cancel'){ clearPending(key); reply = '알겠어요, 취소했어요. 😊'; }
  else if(reviseCreate){ reply = await revisePending(pending, intent, key); }
  else if(pending && ['site_schedule','site_schedule_many','site_schedule_ask'].includes(pending.op) && action==='revise'){
    reply = await prepareSiteSchedule({ site: { query: intent.site?.query || pending.query,
      phase: intent.site?.phase || pending.phase, date: intent.site?.date || intent.event?.date, changes:intent.site?.changes } }, key);
  }
  else if(pending && (action==='chat' || action==='calendar' || action==='gmail' || action==='drive' || action==='sheet')){
    // 대기 중인데 못 알아들은 말/엉뚱한 말 → 대기를 깨지 말고 다시 확인 요청
    reply = `방금 건 잘 못 알아들었어요. 🤔 아래 내용으로 진행할까요?\n\n${pendingSummary(pending)}\n\n"응"이면 진행, "취소"면 취소할게요.`;
  }
  else if(action==='create'||action==='update'||action==='delete'){ clearPending(key); reply = await prepareWrite({...intent, action, _utterance:utterance}, key); }
  else if(action==='site_add'||action==='site_status'){ clearPending(key); reply = await prepareSite({...intent, action}, key); }
  else if(action==='site_schedule'){ reply = await prepareSiteSchedule(intent, key); }
  else if(action==='chat'){ clearPending(key); reply = await chat(utterance, history); }
  else { clearPending(key); const gas = await fetchGas({...intent, action}); reply = await summarize(utterance, gas, history); }

  if(reply == null) return null;
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

형식: {"action":"calendar|gmail|drive|sheet|chat|create|update|delete|confirm|cancel|revise|site_add|site_status|site_schedule","from":null,"to":null,"gmailQuery":null,"driveName":null,"driveQuery":null,"keyword":null,"event":{"title":null,"date":"yyyy-mm-dd|null","start":"HH:mm|null","end":"HH:mm|null","allDay":false,"category":null,"guests":[],"names":[],"findDate":null,"findDateTo":null,"target":null},"site":{"address":null,"vendor":null,"note":null,"spaceType":null,"area":null,"meetingDate":null,"startDate":null,"firstSurvey":null,"installDate":null,"proposer":null,"fieldMgr":null,"fieldMgrSub":null,"custName":null,"custTel":null,"siteMgr":null,"siteMgrTel":null,"siteLead":null,"siteLeadTel":null,"query":null,"status":null,"phase":null,"date":null,"changes":null,"scheduleError":null}}

[분류]
- 일정 조회→calendar, 메일→gmail, 드라이브/파일→drive, 시트→sheet
- 일정 추가→create, 일정 수정/변경→update, 일정 삭제/취소→delete
- 현장의 실사·배선·조명설치·SW세팅·검수인계 날짜 수정은 최우선으로 site_schedule. 체크리스트/현장감리리스트의 공정 날짜이며 일반 구글 캘린더 update로 분류하지 마. 사용자가 명시적으로 '구글 캘린더'라고 한 경우에만 캘린더 일정으로 처리해.
- 예: '수원 인계동 현장 조명 설치일을 모레로 수정해줘' → site_schedule, site.query='수원 인계동', site.phase='조명설치', site.date=오늘+2일. site.query에는 현장명/주소/업체명만 넣고 공정명·날짜·수정 요청 문구는 빼.
- site_schedule의 phase는 실사|배선|조명설치|SW세팅|검수인계. 날짜는 사용자가 지정한 새 날짜만 yyyy-MM-dd로 넣고 없으면 null. 한 현장의 여러 공정을 한 번에 바꾸면 site.changes=[{"phase":"조명설치","date":"yyyy-MM-dd"},{"phase":"SW세팅","date":"yyyy-MM-dd"}]에 모두 넣어. 하나라도 날짜가 불분명하면 null로 남기고 누락하지 마. '10월2일 → 10월3일'이면 새 날짜인 10월3일만 date에 넣어. 여러 현장이 섞였으면 site.scheduleError='현장 한 곳씩 요청해 주세요.'로 반환해. 확인 대기 중 새 공정을 더 말하면 같은 현장의 기존 요청에 합치고, 특정 공정 날짜 정정은 그 공정만 바꿔.
- 인사·잡담·불가능한 요청→chat
[맥락 이어받기] "그중에서/그건/그럼 그건/PDF로 된 거" 처럼 앞을 가리키면 직전 대화의 대상·조건을 이어받아 채워.
[calendar] from/to 날짜. "오늘"→from=to=오늘, 하루면 from=to 동일, "이번주/다음주/주말/이번달"은 범위, 없으면 null.
[gmail] gmailQuery=Gmail검색식 (from:이름 / is:unread / has:attachment / newer_than:3d). 막연하면 null.
[drive] driveName=파일명에서 찾을 핵심 단어/문구(폴더 위치 무시, 부분일치). 예) "스마트홈 표준계약서 찾아줘"→driveName="표준계약서". 파일종류까지 좁혀야 할 때만 driveQuery=Drive검색식(mimeType 등). 보통은 driveName만 채우고 driveQuery는 null.
[sheet] keyword=시트 이름 핵심 단어.
[현장리스트 시트] '현장리스트'에 현장을 다루면:
- 일련번호/현장코드(A열)는 사용자가 시트에서 수기로 관리해. 비서는 번호를 발급·수정·복원·숨김 처리하지 않으며 상태 변경으로 번호가 자동 생성된다고 안내하지 마.
- 새 현장 추가 → action="site_add". site에 말한 항목만 채워: address(현장주소·필수), vendor(인테리어 업체명), proposer(아카라 영업담당), fieldMgr(현장담당 정=주담당), fieldMgrSub(현장담당 부=보조담당), spaceType(유형: 아파트/단독주택/오피스/상가/공공기관), area(공급면적 평수 숫자), meetingDate(3자미팅일 yyyy-mm-dd), startDate(계약일 yyyy-mm-dd), firstSurvey(실사일 yyyy-mm-dd), installDate(조명설치예정일 yyyy-mm-dd), custName/custTel(고객성함·연락처), siteMgr/siteMgrTel(현장실장·실장 연락처), siteLead/siteLeadTel(현장소장·소장 연락처), note(특이사항). 진행상태는 서버가 자동(제안)이니 넣지 마.
  ★현장담당 정/부 구분(중요): "현장담당: 정 홍길동" 또는 "현장담당(정) 홍길동" → fieldMgr=홍길동. "현장담당(부): 김철수" 또는 "현장담당 보조 김철수" → fieldMgrSub=김철수. 절대 두 사람을 fieldMgr 하나에 몰아넣지 마. 부담당은 반드시 fieldMgrSub에만 넣어. 정/부 표시가 없이 이름 하나만 있으면 fieldMgr(정)로.
  ★현장 필드는 서버가 이름을 그대로 시트에 적어(이메일 변환 안 함). 그러니 사람 이름은 한글 이름 그대로 넣어.
- 현장 상태 변경 → action="site_status". site.query=현장 찾을 말(주소+업체명, 예: "테라디자인 베른"), site.status=제안|진행중|완료|취소.
[중요·날짜기준] '오늘/내일/어제/모레/이번주/다음주/요일'은 모두 위에 적힌 오늘 날짜(Asia/Seoul) 기준으로 정확히 환산해.
[event] create/update/delete일 때: title=제목, start/end="HH:mm"(24시간, 없으면 null), "종일"이면 allDay=true. 장소·현장명이 언급되면 제목에 반드시 포함해(예: "안산 현장으로 외근 추가"→title="안산 현장 외근", "코리아빌드 참관 잡아줘"→title="코리아빌드 참관"). category=분류(내근/외근/손님/의사결정회의/공지/쇼룸/상현룸/성범룸/왕환룸, "기본"이면 "기본", 없으면 null). "○○룸에/에서 회의","쇼룸 예약"처럼 회의실을 지정하면 그 방 이름을 category로 넣어(예: "상현룸에 3시 회의"→category="상현룸"). target=기존 일정 찾을 제목 키워드.
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
    const ok = ['calendar','gmail','drive','sheet','chat','create','update','delete','confirm','cancel','revise','site_add','site_status','site_schedule'];
    const c = v => (v && v!=='null' ? v : null);
    const ev = o.event || {};
    return {
      action: ok.includes(o.action)?o.action:'chat',
      from:c(o.from), to:c(o.to), gmailQuery:c(o.gmailQuery), driveName:c(o.driveName), driveQuery:c(o.driveQuery), keyword:c(o.keyword),
      event:{ title:c(ev.title), date:c(ev.date), start:c(ev.start), end:c(ev.end), allDay:!!ev.allDay, category:c(ev.category), guests:Array.isArray(ev.guests)?ev.guests.filter(x=>x&&x.indexOf('@')!==-1):[], names:Array.isArray(ev.names)?ev.names.filter(Boolean):[], findDate:c(ev.findDate), findDateTo:c(ev.findDateTo), target:c(ev.target) },
      site: (function(st){ st=st||{}; const o={}; ['address','vendor','note','spaceType','area','meetingDate','startDate','firstSurvey','installDate','proposer','fieldMgr','fieldMgrSub','custName','custTel','siteMgr','siteMgrTel','siteLead','siteLeadTel','query','status','phase','date','scheduleError'].forEach(k=>{ o[k]=c(st[k]); }); if(Array.isArray(st.changes)) o.changes=st.changes.map(item=>({phase:c(item?.phase),date:c(item?.date)})); return o; })(o.site),
    };
  }catch{ return { action:'chat', event:{}, site:{} }; }
}

/* 체크리스트 공정명과 날짜를 분리한다. 이 경로에서는 AI가 수정 대상을 결정하지 않는다. */
const SITE_SCHEDULE_PHASES = [
  { phase: '실사', pattern: /(?:최초\s*)?실사/i },
  { phase: '배선', pattern: /(?:전기\s*)?배선/i },
  { phase: '조명설치', pattern: /조명\s*설치/i },
  { phase: 'SW세팅', pattern: /(?:s\s*w|소프트웨어)\s*(?:세팅|셋팅|설정)/i },
  { phase: '검수인계', pattern: /검수\s*(?:[·/ㆍ]\s*)?(?:인계)?|인계\s*일/i },
];
// 오늘 기준 N일 뒤/후. 번지·소수·음수의 일부나 '후문/뒤편'은 날짜로 읽지 않는다.
const SITE_SCHEDULE_RELATIVE_DAYS = /(?<![\d./+\-])(\d{1,4})\s*일\s*(?:뒤|후)(?=$|[^가-힣\d]|로|에|야|이야|입니다)/g;

function validSiteScheduleDate(value){
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value;
}
function siteScheduleAddDays(today, days){
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function siteScheduleDateFromText(text, today){
  // '모레 말고 내일'은 마지막 정정만 반영한다.
  const latest = String(text).split(/말고|아니고/).pop().replace(/내일\s*모레/g, '모레');
  const dates = [];
  const absolute = /(?<![\d./-])(?:(\d{4})\s*(?:[-/.]|년)\s*)?(\d{1,2})\s*(?:[-/.]|월)\s*(\d{1,2})(?:\s*일)?(?!\d|\s*(?:번지|번길|동|호|층))/g;
  let match;
  while((match = absolute.exec(latest))){
    dates.push(`${match[1] || today.slice(0,4)}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`);
  }
  const relative = latest.match(/오늘|내일|모레|글피/g) || [];
  relative.forEach(day => dates.push(siteScheduleAddDays(today, {오늘:0, 내일:1, 모레:2, 글피:3}[day])));
  for(const match of latest.matchAll(SITE_SCHEDULE_RELATIVE_DAYS)){
    dates.push(siteScheduleAddDays(today, Number(match[1])));
  }
  const week = latest.match(/(?:(다다음|다음|이번)\s*주\s*)?([월화수목금토일])요일/);
  if(week){
    const current = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
    const target = '월화수목금토일'.indexOf(week[2]);
    const offset = week[1] ? target - current + ({이번:0, 다음:7, 다다음:14}[week[1]]) : (target - current + 7) % 7;
    dates.push(siteScheduleAddDays(today, offset));
  }
  const unique = [...new Set(dates)];
  return unique.length === 1 ? unique[0] : '';
}

function siteSchedulePendingChanges(pending){
  if(!pending) return [];
  if(pending.op === 'site_schedule_many') return pending.items.map(item=>({phase:item.phase,date:item.date}));
  if(Array.isArray(pending.changes)) return pending.changes.map(item=>({phase:item.phase,date:item.date}));
  return pending.phase ? [{phase:pending.phase,date:pending.date || ''}] : [];
}
function siteScheduleTargetDate(text,today){
  // 왼쪽의 이전 날짜는 검색 기준이 아니다. 실제 이전 날짜는 GAS에서 읽는다.
  const latest = String(text).split(/말고|아니고/).pop();
  const parts = latest.split(/(?:->|=>|→|에서|부터)/);
  return siteScheduleDateFromText(parts[parts.length-1],today);
}
function siteScheduleBatchSegmentIsDate(text){
  // 공정 사이에 다른 현장 이름이 섞이면 앞 현장에 모두 적용하지 않는다.
  const leftover = String(text)
    .replace(SITE_SCHEDULE_RELATIVE_DAYS,'')
    .replace(/(?:(?:\d{4})\s*(?:[-/.]|년)\s*)?\d{1,2}\s*(?:[-/.]|월)\s*\d{1,2}(?:\s*일)?/g,'')
    .replace(/(?:(?:다다음|다음|이번)\s*주\s*)?[월화수목금토일]요일/g,'')
    .replace(/내일\s*모레|오늘|내일|모레|글피/g,'')
    .replace(/수정\s*해\s*줘|변경\s*해\s*줘|바꿔\s*줘|고쳐\s*줘|조정\s*해\s*줘|설정\s*해\s*줘|잡아\s*줘|입력\s*해\s*줘|옮겨\s*줘|미뤄\s*줘|당겨\s*줘|변경|수정|일괄|함께|모두|예정일|날짜|일정|그리고|이랑|으로|에서|부터|까지|말고|아니고|하고|해주세요|해줘|할게|해요|입니다|은|는|을|를|일|이|가|로|랑|와|과|도|에/g,'')
    .replace(/[\s,，;:：·/()<>＝=→\-_.~!?]/g,'');
  return !leftover;
}
function parseSiteScheduleCommand(utterance, pending = null, today = new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Seoul'})){
  const text = String(utterance || '').trim();
  const continuing = pending && ['site_schedule','site_schedule_many','site_schedule_ask'].includes(pending.op);
  const previousChanges = continuing ? siteSchedulePendingChanges(pending) : [];
  const error = message=>({action:'site_schedule',site:{},error:message});
  if(continuing && /^(?:응|네|예|맞아|그래|좋아|ㅇㅇ|확인|진행해|그대로\s*(?:진행|해줘)?)[.!?\s]*$/.test(text)){
    return pending.op !== 'site_schedule_ask' ? {action:'confirm'} : {action:'site_schedule',site:{query:pending.query,phase:pending.phase,date:pending.date,changes:pending.changes}};
  }
  if(continuing && /^(?:취소|아니|아니야|하지\s*마|안돼)[.!?\s]*$/.test(text)) return {action:'cancel'};
  if(/구글\s*캘린더|google\s*calendar|새\s*현장|현장.*(?:추가|등록)/i.test(text)) return null;
  const phases = [];
  SITE_SCHEDULE_PHASES.forEach(rule=>{
    for(const match of text.matchAll(new RegExp(rule.pattern.source,'gi'))) phases.push({phase:rule.phase,match});
  });
  phases.sort((a,b)=>a.match.index-b.match.index);
  const changing = /수정|변경|바꿔|바꾸|고쳐|고치|조정|옮겨|미뤄|당겨|연기|입력|설정|잡아|->|=>|→/.test(text);
  const scoped = /공정/.test(text) || (/현장|체크리스트|감리리스트/.test(text) && /날짜|일정|예정일|[가-힣]+일(?:을|은|이|로|에|\s)/.test(text));
  const dateOnlyReply = /^(?:날짜(?:는|를)?\s*)?(?:(?:\d{4}\s*(?:[-/.]|년)\s*)?\d{1,2}\s*(?:[-/.]|월)\s*\d{1,2}(?:\s*일)?|\d{1,4}\s*일\s*(?:뒤|후)|오늘|내일\s*모레|내일|모레|글피|(?:(?:다다음|다음|이번)\s*주\s*)?[월화수목금토일]요일)(?:\s*(?:로|으로)?\s*(?:해줘|바꿔줘|수정해줘|변경해줘|야|이야|입니다)?)?[.!?\s]*$/.test(text);
  if(continuing && pending.asking === 'query' && !phases.length && !changing && !dateOnlyReply && !/메일|드라이브|회의|캘린더/.test(text)){
    return {action:'site_schedule',site:{query:text.replace(/\s*현장(?:이야|입니다)?\s*$/, '').trim(),phase:pending.phase,date:pending.date,changes:pending.changes}};
  }
  const dateText = phases.length ? text.slice(phases[0].match.index+phases[0].match[0].length) : text;
  const date = siteScheduleTargetDate(dateText,today) || (/^(?:오늘|내일|모레|글피)\s+/.test(text) ? siteScheduleTargetDate(text.split(/\s+/)[0],today) : '');
  const continuation = continuing && !/메일|드라이브|회의|캘린더/.test(text) &&
    (date || phases.length || (pending.op === 'site_schedule_ask' && pending.asking === 'query'));
  if(!continuation && !(changing && (phases.length || scoped))) return null;
  if(/(?:\d{1,2}\s*시|\d{1,2}:\d{2})/.test(text)) return error('체크리스트에는 공정 날짜만 기록해요. 시간을 제외하고 바꿀 날짜를 알려주세요.');
  if(phases.length > 5 || new Set(phases.map(item=>item.phase)).size !== phases.length) return error('같은 공정에 날짜를 여러 번 지정했어요. 공정마다 바꿀 날짜를 하나씩 알려주세요.');
  if(phases.length && /계약일|발주일|납기일|3자\s*미팅|미팅일/.test(dateText)) return error('변경할 항목을 모두 확인하지 못했어요. 실사 / 배선 / 조명설치 / SW세팅 / 검수인계의 날짜만 함께 지정해 주세요.');
  let query = phases.length ? text.slice(0,phases[0].match.index) : '';
  query = query.replace(/^(?:체크\s*리스트|현장\s*감리\s*리스트|현장\s*리스트|감리\s*리스트|공정\s*캘린더)(?:에서|의|에)?\s*/, '')
    .replace(/^(?:오늘|내일|모레|글피)\s+/, '')
    .replace(/\s*현장(?:의|은|는|에서|에)?\s*$/, '').replace(/의\s*$/, '').trim();
  if(continuation && (!query || /^(?:아니|그럼|그러면|그리고|거기에|추가로|그|같은|날짜를?|일정을?)$/.test(query))) query = pending.query;
  if(phases.length > 1){
    const changes = phases.map((item,index)=>{
      const segment = text.slice(item.match.index+item.match[0].length,phases[index+1]?.match.index ?? text.length);
      return {phase:item.phase,date:siteScheduleTargetDate(segment,today),clean:siteScheduleBatchSegmentIsDate(segment)};
    });
    if(changes.some(item=>!item.clean)) return error('여러 현장이나 다른 요청이 섞였는지 확인해 주세요. 현장 한 곳을 먼저 적고, 각 공정의 새 날짜를 하나씩 알려주세요.');
    if(changes.some(item=>!validSiteScheduleDate(item.date))) return error('공정마다 바꿀 날짜를 하나씩 정확히 알려주세요. 날짜가 빠지거나 여러 개로 해석돼 아직 변경을 준비하지 않았어요.');
    return {action:'site_schedule',site:{query,changes:changes.map(({phase,date})=>({phase,date}))}};
  }
  if(!phases.length && previousChanges.length > 1) return error('어느 공정의 날짜를 바꿀지 함께 알려주세요. 확인 대기 중인 여러 공정에 같은 날짜를 임의로 적용하지 않을게요.');
  if(/(?:전부|모두|일괄|둘\s*다)/.test(text) && phases.length < 2) return error('함께 바꿀 공정명과 날짜를 각각 하나씩 알려주세요.');
  const phase = phases[0]?.phase || (continuation ? pending.phase : '');
  return {action:'site_schedule',site:{query,phase,date:date || (continuation && pending.op === 'site_schedule_ask' && pending.asking !== 'date' ? pending.date : '')}};
}

async function prepareSiteSchedule(intent, key){
  if(!key) return '사용자를 확인할 수 없어요. 비서와의 개인 대화에서 다시 요청해 주세요.';
  const st = intent.site || {};
  const previous = getPending(key);
  const continuing = previous && ['site_schedule','site_schedule_many','site_schedule_ask'].includes(previous.op);
  const query = typeof st.query === 'string' ? st.query.trim() : (continuing ? previous.query : '');
  const normalizeQuery = value=>String(value || '').replace(/\s+/g,'').toLowerCase();
  const raw = Array.isArray(st.changes) ? st.changes : [{phase:st.phase,date:st.date}];
  let changes = raw.map(item=>({phase:typeof item?.phase === 'string' ? item.phase.trim() : '',date:typeof item?.date === 'string' ? item.date.trim() : ''}));
  let inputError = intent.error || st.scheduleError;
  if(Array.isArray(st.changes) && (!changes.length || changes.length > 5 || changes.some(item=>!SITE_SCHEDULE_PHASES.some(rule=>rule.phase === item.phase)))){
    inputError = '변경할 모든 공정을 확인하지 못했어요. 실사 / 배선 / 조명설치 / SW세팅 / 검수인계 중에서 공정명과 새 날짜를 각각 알려주세요.';
  }
  if(new Set(changes.map(item=>item.phase)).size !== changes.length) inputError = '같은 공정에 날짜를 여러 번 지정했어요. 공정마다 날짜를 하나씩 알려주세요.';
  if(!inputError && continuing && normalizeQuery(query) && normalizeQuery(query) === normalizeQuery(previous.query)){
    const merged = siteSchedulePendingChanges(previous);
    changes.forEach(change=>{
      if(!change.phase) return;
      const at = merged.findIndex(item=>item.phase === change.phase);
      if(at === -1) merged.push(change); else merged[at] = change;
    });
    if(changes.every(item=>item.phase)) changes = merged;
  }
  const signature = items=>items.map(item=>`${item.phase}|${item.date}`).sort().join('\n');
  // 같은 확인 내용을 반복해서 말하면 검색과 확인 카드를 다시 보내지 않는다.
  if(!inputError && continuing && ['site_schedule','site_schedule_many'].includes(previous.op) &&
    normalizeQuery(query) === normalizeQuery(previous.query) && signature(changes) === signature(siteSchedulePendingChanges(previous))) return null;
  clearPending(key);
  if(inputError) return `⚠️ ${inputError}`;
  const phase = changes.length === 1 && SITE_SCHEDULE_PHASES.some(rule=>rule.phase === changes[0].phase) ? changes[0].phase : '';
  const date = changes.length === 1 ? changes[0].date : '';
  if(changes.length === 1 && !phase){
    setPending(key, {op:'site_schedule_ask',query,phase,date,asking:'phase'});
    return '체크리스트에서 어느 공정 날짜를 바꿀까요? 실사 / 배선 / 조명설치 / SW세팅 / 검수인계 중 하나를 알려주세요.';
  }
  if(!query){
    setPending(key, {op:'site_schedule_ask',query,phase,date,changes:changes.length > 1 ? changes : undefined,asking:'query'});
    return `${changes.map(item=>item.phase).join('·')} 날짜를 바꿀 현장의 주소나 업체명을 알려주세요.`;
  }
  if(changes.some(item=>!validSiteScheduleDate(item.date))){
    if(changes.length === 1){
      setPending(key, {op:'site_schedule_ask',query,phase,date:'',asking:'date'});
      return `${query} 현장의 ${phase} 날짜를 언제로 바꿀까요? ${date ? '존재하는 날짜로 ' : ''}날짜 하나를 알려주세요. (예: 모레 / 2026-10-01)`;
    }
    setPending(key, {op:'site_schedule_ask',query,changes,asking:'changes'});
    return `공정마다 바꿀 날짜를 하나씩 알려주세요. ${changes.filter(item=>!validSiteScheduleDate(item.date)).map(item=>item.phase).join('·')}의 날짜를 확인하기 전에는 일부만 변경하지 않아요.`;
  }
  const found = await findSiteScheduleGroups(query, changes.map(change=>change.phase), {timeout:25000});
  if(found.failure) return found.failure;
  const items = [];
  let target;
  let identity;
  for(let index=0;index<changes.length;index++){
    const change = changes[index], list = found.groups[index].rows;
    if(!list.length) return `'${query}'에 맞는 현장을 체크리스트에서 찾지 못했어요. 주소나 업체명을 다시 알려주세요.`;
    if(list.length > 1){
      setPending(key,{op:'site_schedule_ask',query:'',phase,date,changes:changes.length > 1 ? changes : undefined,asking:'query'});
      return '체크리스트에 해당 현장이 여러 곳 있어요. 주소나 업체명을 더 구체적으로 알려주세요.\n'+
        list.slice(0,8).map(row=>`• ${row.address} / ${row.vendor || '업체 미입력'} / ${change.phase}: ${row.date || '미입력'}`).join('\n');
    }
    const row = list[0];
    let rowIdentity;
    try{ rowIdentity = JSON.stringify(JSON.parse(row.scheduleRef).siteRef); }catch{ /* 최종 같은 현장 검증은 GAS도 수행한다. */ }
    if(target && (target.address !== row.address || target.vendor !== row.vendor || (identity && rowIdentity && identity !== rowIdentity))){
      return '⚠️ 공정별 검색 결과의 현장이 서로 다르거나 검색 중 현장이 변경됐어요. 한 현장의 주소와 공정 날짜를 다시 알려주세요.';
    }
    target = target || row; identity = identity || rowIdentity;
    items.push({phase:change.phase,date:change.date,oldDate:row.date,scheduleRef:row.scheduleRef,address:row.address,vendor:row.vendor});
  }
  if(items.every(item=>item.oldDate === item.date)) return `체크리스트의 ${target.address} / ${items.map(item=>`${item.phase} 날짜는 이미 ${item.date}`).join(', ')}예요.`;
  const base = {query,address:target.address,vendor:target.vendor,summary:target.address+(target.vendor ? ' / '+target.vendor : '')};
  if(items.length === 1) setPending(key,{...base,op:'site_schedule',...items[0]});
  else setPending(key,{...base,op:'site_schedule_many',items});
  return `체크리스트 공정일을 이렇게 바꿀까요?\n📍 ${base.summary}\n${items.map(item=>`${item.phase}: ${item.oldDate || '미입력'} → ${item.date}`).join('\n')}\n\n맞으면 "응", 아니면 "취소"라고 해주세요.`;
}

/* 같은 현장의 여러 공정을 한 요청으로 조회한다. 옛 배포나 부분 응답은 카드로 만들지 않는다. */
async function findSiteScheduleGroups(query, phases, options = {}){
  const batch = phases.length > 1;
  const response = await gasCall(batch
    ? {action:'site_schedule_find_many',q:query,phases:JSON.stringify(phases)}
    : {action:'site_schedule_find',q:query,phase:phases[0]}, options);
  if(response?.error || response?.result?.error){
    return {failure:gasFailure(response,'체크리스트 현장을 검색하지 못했어요.')};
  }
  if(response?.scheduleApiVersion !== 1){
    return {failure:'⚠️ 비서에 연결된 Apps Script에서 공정일 API 버전을 확인하지 못했어요. Render의 GAS_URL과 새 버전으로 갱신한 웹앱 URL이 같은지 확인해 주세요.\n' + gasDeploymentHint()};
  }
  if(batch && (response.scheduleBatchApiVersion !== 1 || response.scheduleFindBatchApiVersion !== 1)){
    return {failure:'⚠️ 연결된 Apps Script에서 여러 공정 날짜를 함께 조회하는 기능을 확인하지 못했어요. 최신 수정본으로 기존 웹앱 배포를 갱신해 주세요.'};
  }
  const groups = batch ? response.result : [{phase:phases[0],rows:response.result}];
  if(!Array.isArray(groups) || groups.length !== phases.length || groups.some((group,index)=>
    !group || group.phase !== phases[index] || !Array.isArray(group.rows) || group.rows.some(row=>
      !row || typeof row.address !== 'string' || !row.address || typeof row.vendor !== 'string' || row.phase !== phases[index] ||
      typeof row.date !== 'string' || (row.date && !validSiteScheduleDate(row.date)) || typeof row.scheduleRef !== 'string' || !row.scheduleRef))){
    return {failure:'⚠️ 공정일 API 연결은 확인됐지만 현장 검색 결과에 주소·공정·날짜·확인 정보가 누락되었거나 형식이 달라요. 체크리스트의 현장주소와 Apps Script 검색 응답을 확인해 주세요.'};
  }
  return {groups};
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
  add('아카라 영업담당', st.proposer);
  add('현장담당(정)', st.fieldMgr); add('현장담당(부)', st.fieldMgrSub);
  add('3자미팅일', st.meetingDate);
  add('계약일', st.startDate); add('실사일', st.firstSurvey); add('설치예정일', st.installDate);
  add('고객성함', st.custName); add('고객연락처', st.custTel);
  add('현장실장', st.siteMgr); add('실장 연락처', st.siteMgrTel);
  add('현장소장', st.siteLead); add('소장 연락처', st.siteLeadTel);
  add('특이사항', st.note);
  return L.join('\n');
}

/* ===== 현장 추가 대화 (되묻기 + 확인카드 수정) =====
 * 새 현장 추가 시 '비어 있는 칸'만 아래 순서대로 하나씩 물어봄.
 * 답은 항상 '필드 단위'로 해석 → "유형은 아파트, 면적은 몰라" 같이 한 번에 답해도 OK.
 * - 값 → 그 칸 채움 (여러 개 동시에 말해도 각 칸에)
 * - "몰라/없어/패스/스킵" → 그 칸은 빈칸 유지하고 다시 안 물어봄 (값으로 안 박음)
 * - "그만/끝/이대로" → 나머지 안 묻고 바로 확인 카드
 * - "취소" → 현장 추가 자체 취소
 * 확인 카드에서 "유형 아파트로" 처럼 특정 칸만 고치는 것도 됨.
 * 필요 없는 항목은 ASK_FIELDS에서 줄을 지우면 되고, 순서는 배열 순서대로.
 */
const ASK_FIELDS = [
  { key:'spaceType',    q:'유형이 뭐예요? (아파트 / 단독주택 / 오피스 / 상가 / 공공기관)' },
  { key:'area',         q:'공급면적은 몇 평이에요? (숫자만, 예: 34)' },
  { key:'vendor',       q:'인테리어 업체는 어디예요?' },
  { key:'proposer',     q:'아카라 영업담당은 누구예요?' },
  { key:'fieldMgr',     q:'현장담당(정)은 누구예요?' },
  { key:'fieldMgrSub',  q:'현장담당(부)는 누구예요? (없으면 "없어")' },
  { key:'custName',     q:'고객 성함은요?' },
  { key:'custTel',      q:'고객 연락처는요?' },
  { key:'meetingDate',  q:'3자미팅일은 언제예요? (예: 오늘, 7월 3일 / 없으면 "없어")' },
];
// 되묻기/확인카드 답을 필드 단위로 뽑을 때 허용하는 현장 필드 키
const SITE_FIELD_KEYS = ['address','spaceType','area','vendor','proposer','fieldMgr','fieldMgrSub','meetingDate',
  'custName','custTel','siteMgr','siteMgrTel','siteLead','siteLeadTel','startDate','firstSurvey','installDate','note'];
const SITE_DATE_FIELDS = new Set(['meetingDate','startDate','firstSurvey','installDate']);
// 확인 카드에서 순수 긍정(추가 진행). 전체가 이 말일 때만 매치 → "유형 아파트"는 매치 안 됨
const SITE_CONFIRM_RE = /^(응|응응|넹|네|넵|예|어|엉|ㅇㅇ|ㅇ|오케이|오키|오케|ok|okay|콜|고|가자|맞아|맞아요|맞습니다|그래|그래요|좋아|좋아요|굿|그대로|그대로\s?진행|진행|진행해|진행해줘|추가|추가해|추가해줘|등록|등록해|등록해줘|해줘|해)$/i;

/* 사용자 답을 필드 단위로 해석 (여러 개 동시/‘유형은 X’ 접두어/항목별 몰라 처리) */
async function parseSiteReply(utterance, askingKey){
  const today = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Seoul' });
  const askLabel = (ASK_FIELDS.find(f=>f.key===askingKey)||{}).q || '(특정 항목 아님, 자유 수정)';
  const prompt =
`오늘은 ${today} (Asia/Seoul). 너는 '현장리스트' 입력 도우미야. 지금 사용자에게 이걸 물어본 상태야: "${askLabel}"
사용자 답: "${utterance}"
아래 규칙대로 JSON 한 줄만 출력(설명·코드블록 없이):
{"site":{},"skip":[],"done":false,"cancel":false}
[필드키] address(현장주소), spaceType(유형: 아파트/단독주택/오피스/상가/공공기관), area(공급면적 평수 숫자만), vendor(인테리어 업체), proposer(아카라 영업담당 이름), fieldMgr(현장담당 정=주 이름), fieldMgrSub(현장담당 부=보조 이름), meetingDate(3자미팅일), custName(고객성명), custTel(고객연락처), siteMgr(현장실장), siteMgrTel(실장연락처), siteLead(현장소장), siteLeadTel(소장연락처), startDate(계약일), firstSurvey(실사일), installDate(조명설치예정일), note(특이사항)
[규칙]
- 사용자가 말한 현장 정보를 site에 '해당 필드키'로 넣어. 한 번에 여러 개 말하면 전부 각 필드에 넣어.
- "유형은 아파트", "면적 34평", "담당 정은 박성범"처럼 '필드명+값' 형태면 값만 뽑아 넣어(spaceType="아파트", area="34", fieldMgr="박성범").
- 현장담당 '정/주'는 fieldMgr, '부/보조'는 fieldMgrSub. 절대 두 명을 한 필드에 몰지 마.
- 어떤 항목을 "몰라/모름/없어/없음/패스/스킵/나중에/생략"이라고 하면 그 필드키를 skip 배열에 넣고 site엔 넣지 마. (예: "면적은 몰라"→skip:["area"])
- 지금 물어본 항목("${askingKey||''}")에 대한 단순 값 답(예: "아파트")이면 그 항목 필드에 넣어.
- "그만/끝/됐어/이대로/여기까지/바로 추가/그냥 추가"면 done=true.
- "취소/관둬/그만둬/하지마"면 cancel=true.
- 날짜 필드는 오늘 기준 yyyy-mm-dd로 환산. area는 숫자만.
- 해당 없는 건 넣지 마. 아무 현장정보·신호도 없으면 site는 {} 로.`;
  try{
    const txt = (await askAI(prompt)).replace(/```json|```/g,'').trim();
    const o = JSON.parse(txt);
    const cln = v => (v!=null && String(v).trim()!=='' && String(v).trim().toLowerCase()!=='null') ? String(v).trim() : null;
    const site = {};
    if(o.site && typeof o.site==='object'){
      SITE_FIELD_KEYS.forEach(k=>{ const v=cln(o.site[k]); if(v!=null) site[k]=v; });
    }
    if(site.area){ const m=String(site.area).match(/\d+(\.\d+)?/); site.area = m?m[0]:site.area; }
    // 날짜 재검증: yyyy-mm-dd 아니면 버림(오입력 방지)
    SITE_DATE_FIELDS.forEach(k=>{ if(site[k] && !/^\d{4}-\d{2}-\d{2}$/.test(site[k])) delete site[k]; });
    const skip = Array.isArray(o.skip) ? o.skip.filter(k=>SITE_FIELD_KEYS.includes(k)) : [];
    return { site, skip, done:!!o.done, cancel:!!o.cancel };
  }catch{ return { site:{}, skip:[], done:false, cancel:false }; }
}

function siteConfirmCard(site, lead){
  return `${lead}\n📋 현장리스트 (진행상태: 제안)\n${fmtSite(site)}\n\n맞으면 "응", 아니면 "취소". (특정 칸만 고치려면 "유형 아파트로"처럼 말해줘)`;
}

// 다음으로 물어볼 빈 칸(스킵된 건 제외)을 찾아 질문. 없으면 확인 카드.
function askNextSiteField(site, key, skipped){
  skipped = skipped || [];
  for(const f of ASK_FIELDS){
    if(skipped.includes(f.key)) continue;
    const v = site[f.key];
    if(v==null || String(v).trim()===''){
      setPending(key, { op:'site_ask', site, asking:f.key, skipped });
      return `📋 ${site.address}\n\n${f.q}\n(모르면 "몰라", 그만 물어보고 바로 추가하려면 "그만")`;
    }
  }
  setPending(key, { op:'site_add', site, skipped });
  return siteConfirmCard(site, '이렇게 맨 위에 추가할게요 👇');
}

async function doSiteAdd(site, key){
  clearPending(key);
  const r = await gasCall(Object.assign({ action:'site_add' }, site));
  return r?.result?.ok ? `✅ 현장을 추가했어요! (진행상태: 제안)\n${fmtSite(site)}` : gasFailure(r, '현장 추가를 완료하지 못했어요.');
}

/* 현장 추가 대화 처리 (site_ask 되묻기 + site_add 확인카드 공통) */
async function handleSiteFlow(pending, utterance, key){
  const u = String(utterance||'').trim();
  const site = Object.assign({}, pending.site || {});
  const skipped = Array.isArray(pending.skipped) ? pending.skipped.slice() : [];

  // 확인 카드 단계에서 순수 긍정 → 바로 추가
  if(pending.op==='site_add' && SITE_CONFIRM_RE.test(u)){
    return await doSiteAdd(site, key);
  }

  const p = await parseSiteReply(u, pending.asking);
  if(p.cancel){ clearPending(key); return '알겠어요, 현장 추가를 취소했어요. 😊'; }

  // 필드 병합 + 스킵 누적
  Object.keys(p.site).forEach(k=>{ site[k] = p.site[k]; });
  p.skip.forEach(k=>{ if(!skipped.includes(k)) skipped.push(k); });

  // 방금 물어본 칸(주소 제외)이 여전히 비어 있으면 스킵 처리 → 같은 질문 무한반복 방지
  if(pending.op==='site_ask' && pending.asking && pending.asking!=='address'){
    const av = site[pending.asking];
    if((av==null || String(av).trim()==='') && !skipped.includes(pending.asking)) skipped.push(pending.asking);
  }

  // 주소는 필수
  if(!site.address){
    setPending(key, { op:'site_ask', site, asking:'address', skipped });
    return '현장주소는 꼭 필요해요. 📍 주소를 알려주세요. (그만두려면 "취소")';
  }

  // "그만" → 바로 확인 카드
  if(p.done){
    setPending(key, { op:'site_add', site, skipped });
    return siteConfirmCard(site, '그럼 여기까지만 채워서 추가할게요 👇');
  }

  // 확인 카드에서 값만 수정한 경우 → 카드 갱신하고 대기 유지 (추가는 "응"에서)
  if(pending.op==='site_add'){
    setPending(key, { op:'site_add', site, skipped });
    return siteConfirmCard(site, '이렇게 바꿨어요 👇');
  }

  // 아직 되묻는 중 → 다음 빈 칸
  return askNextSiteField(site, key, skipped);
}

async function prepareSite(intent, key){
  const st = intent.site || {};
  if(intent.action==='site_add'){
    if(!st.address){
      setPending(key, { op:'site_ask', site: st, asking:'address', skipped:[] });
      return '새 현장은 현장주소부터 알려주세요. 📍 (주소만 넣으면 진행상태는 자동으로 "제안"이 돼요)';
    }
    return askNextSiteField(st, key, []);   // 유형·면적·담당 등 빈 칸을 하나씩 되물음
  }
  // site_status : 현장 찾기
  if(!st.query) return '어떤 현장의 상태를 바꿀까요? 주소나 업체명으로 알려주세요. (예: "테라디자인 베른 현장")';
  if(!st.status) return '어떤 상태로 바꿀까요? 제안 / 진행중 / 완료 / 취소 중에 알려주세요.';
  const found = await gasCall({ action:'site_find', q: st.query });
  if (!Array.isArray(found?.result)) return gasFailure(found, '현장을 검색하지 못했어요.');
  const list = found.result;
  if(!list.length) return `'${st.query}'에 맞는 현장을 못 찾았어요. 🔍 주소나 업체명을 더 구체적으로 알려주세요.`;
  if(list.length>1) return '해당 현장이 여러 개예요. 더 구체적으로 알려주세요.\n'+list.map(x=>`• ${x.code||'(코드없음)'} ${x.address} / ${x.vendor} [${x.status}]`).join('\n');
  const t = list[0];
  if (typeof t.siteRef !== 'string' || !t.siteRef) {
    clearPending(key);
    return '⚠️ 현장 확인 정보가 없어 상태를 변경할 수 없어요. Apps Script의 기존 웹앱 배포를 수정본의 새 버전으로 갱신한 뒤 현장을 다시 검색해 주세요.';
  }
  setPending(key, { op:'site_status', siteRef:t.siteRef, status:st.status, summary:`${t.address} / ${t.vendor}` });
  return `이 현장 상태를 바꿀게요 👇\n📋 ${t.address} / ${t.vendor}\n${t.status} → ${st.status}\n\n맞으면 "응", 아니면 "취소".`;
}

/* ===== 쓰기 준비 (확인 메시지 만들고 대기에 저장) ===== */
async function prepareWrite(intent, key){
  const e = intent.event || {};
  if(intent.action==='create'){
    if(!e.title) return '무슨 일정을 추가할까요? 제목을 알려주세요. 📝';
    if(!e.date)  return `'${e.title}' 일정을 며칠에 추가할까요? 📅`;
    if(!e.allDay && !e.start) return `'${e.title}' (${e.date}) — 몇 시로 잡을까요? ⏰ 종일로 하려면 "종일"이라고 해주세요.`;
    // 분류 자동 추론: 제목이나 발화에 분류/회의실 키워드가 있으면 안 묻고 채움 (예: "외근 일정 추가해줘")
    if(!e.category){
      const hay = `${e.title||''} ${intent._utterance||''}`;
      const CAT_KEYS = ['의사결정회의','내근','외근','손님','공지','쇼룸','상현룸','성범룸','왕환룸'];
      const hit = CAT_KEYS.find(k=>hay.includes(k));
      if(hit) e.category = hit;
    }
    // 제목 양식: 팀 관례 "이름 - 제목" (예: "준규 - 안산 현장 외근"). 이미 "누구 -"로 시작하면 그대로 둠
    if(e.title && !/^[가-힣]{2,4}\s*[-–]/.test(e.title)) e.title = `준규 - ${e.title}`;
    if(!e.category) return `'${e.title}' (${e.date}${e.start?' '+e.start:''}) — 어디로 분류할까요? 📂\n내근 / 외근 / 손님 / 의사결정회의 / 공지·기타 / 기본\n회의실: 쇼룸 / 상현룸 / 성범룸 / 왕환룸 중에 골라주세요.`;
    setPending(key, { op:'create', event:e });
    return `이렇게 추가할게요 👇\n${fmtEvent(e)}\n\n맞으면 "응", 아니면 "취소"라고 해주세요.`;
  }
  // update / delete : 대상 먼저 찾기 (findDate=찾을 날짜, 없으면 오늘~+14일 범위)
  if(!e.findDate && !e.date && !e.target) return `어떤 일정을 ${intent.action==='delete'?'삭제':'수정'}할까요? 날짜나 제목을 알려주세요.`;
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Seoul' });
  const fromDate = e.findDate || todayStr;
  const toDate = e.findDateTo || e.findDate || addDays(fromDate, 14); // 찾을 날짜 없으면 2주 범위
  let found;
  try { found = await gasCalSearch(fromDate, e.target, toDate); }
  catch (err) { return `⚠️ 일정을 검색하지 못했어요.\n${err.message}`; }
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
      const changes = { title:e.title, date:e.date, start:e.start, end:e.end, allDay:e.allDay === true ? '1' : '' };
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
  const changes = { title:e.title, date:e.date, start:e.start, end:e.end, allDay:e.allDay === true ? '1' : '' };
  setPending(key,{ op:'update', id:t.id, calId:t.calId, changes, summary:`${t.start} ${t.title}` });
  return `이 일정을 이렇게 바꿀게요 👇\n기존: ${t.start} ${t.title}\n변경: ${fmtEvent({ title:e.title||t.title, date:e.date, start:e.start, end:e.end, allDay:e.allDay })}\n\n맞으면 "응", 아니면 "취소".`;
}

async function execPending(p){
  if(p.op==='site_schedule_ask') return '현장·공정·바꿀 날짜를 먼저 알려주세요. 아직 변경할 내용을 확인하지 않았어요.';
  if(p.op==='site_schedule_many'){
    const items = p.items;
    if(!Array.isArray(items) || items.length < 2 || items.length > 5 || new Set(items.map(item=>item?.phase)).size !== items.length ||
      typeof p.address !== 'string' || !p.address || items.some(item=>!item || !SITE_SCHEDULE_PHASES.some(rule=>rule.phase === item.phase) ||
        typeof item.scheduleRef !== 'string' || !item.scheduleRef || !validSiteScheduleDate(item.date) || item.address !== p.address ||
        typeof item.oldDate !== 'string' || (item.oldDate && !validSiteScheduleDate(item.oldDate)))){
      return '⚠️ 여러 공정일의 확인 정보가 올바르지 않아요. 현장과 바꿀 날짜 전체를 다시 알려주세요.';
    }
    const response = await gasCall({action:'site_schedule_update_many',items:JSON.stringify(items.map(item=>({scheduleRef:item.scheduleRef,date:item.date})))});
    if(uncertainGasWrite(response)) return recheckSiteSchedule(p);
    const result = response?.result;
    if(response?.error || !result) return gasFailure(response,'체크리스트 공정일 변경 결과를 확인하지 못했어요. 현재 날짜를 확인해 주세요.');
    if(response.scheduleApiVersion !== 1 || response.scheduleBatchApiVersion !== 1){
      return '⚠️ 여러 공정일의 수정 결과를 확인하지 못했어요. 일부 날짜가 반영됐을 수 있으니 현재 체크리스트를 확인해 주세요.';
    }
    const matches = (item,expected)=>item && item.phase === expected.phase && item.date === expected.date && item.address === p.address;
    if(result.ok === true){
      if(result.partial !== false || result.count !== items.length || result.total !== items.length || !Array.isArray(result.items) ||
        result.items.length !== items.length || result.items.some((item,index)=>!matches(item,items[index]) || item.ok !== true || item.status !== 'applied' || item.oldDate !== items[index].oldDate)){
        return '⚠️ 공정일 변경 결과가 확인한 내용과 일치하지 않아요. 날짜가 반영됐을 수 있으니 현재 체크리스트를 확인해 주세요.';
      }
      return `✅ 체크리스트의 공정 날짜 ${items.length}개를 변경했어요.\n📍 ${p.address}\n${items.map(item=>`${item.phase}: ${item.oldDate || '미입력'} → ${item.date}`).join('\n')}\n공정 캘린더를 새로고침하면 반영돼요.`;
    }
    if(result.ok === false && result.partial === false && result.count === 0 && result.total === items.length && Array.isArray(result.items) && !result.items.length){
      return gasFailure(response,'공정일을 변경하지 않았어요. 현장과 날짜를 다시 확인해 주세요.');
    }
    if(result.ok === false && result.total === items.length && Array.isArray(result.items) && result.items.length === items.length &&
      result.items.every((item,index)=>matches(item,items[index]) && item.oldDate === items[index].oldDate &&
        ['applied','uncertain','not_attempted'].includes(item.status) && item.ok === (item.status === 'applied')) &&
      result.count === result.items.filter(item=>item.status === 'applied').length &&
      result.partial === result.items.some(item=>item.status === 'applied' || item.status === 'uncertain')){
      return '⚠️ 공정일 변경이 모두 완료되지는 않았어요. 현재 체크리스트를 확인해 주세요.\n📍 '+p.address+'\n'+
        result.items.map(item=>`• ${item.phase}: ${item.status === 'applied' && item.ok === true ? `${item.date} 반영됨` : item.status === 'not_attempted' ? '아직 처리하지 않음' : '반영 여부 확인 필요'}`).join('\n')+
        (result.error ? `\n${String(result.error)}` : '');
    }
    return '⚠️ 공정일 변경 결과를 확인하지 못했어요. 일부 날짜가 반영됐을 수 있으니 현재 체크리스트를 확인하고 다시 요청해 주세요.';
  }
  if(p.op==='site_schedule'){
    if(typeof p.scheduleRef !== 'string' || !p.scheduleRef || !validSiteScheduleDate(p.date)){
      return '⚠️ 공정일 확인 정보가 없거나 날짜가 올바르지 않아요. 현장과 바꿀 날짜를 다시 알려주세요.';
    }
    const response = await gasCall({action:'site_schedule_update',scheduleRef:p.scheduleRef,date:p.date});
    if(uncertainGasWrite(response)) return recheckSiteSchedule(p);
    const result = response?.result;
    if(!result?.ok) return gasFailure(response, '체크리스트 공정일 변경을 완료하지 못했어요.');
    if(response?.scheduleApiVersion !== 1 || result.date !== p.date || result.phase !== p.phase ||
      typeof result.address !== 'string' || !result.address || (p.address && result.address !== p.address)){
      return '⚠️ 체크리스트 수정 결과를 확인하지 못했어요. 날짜가 반영됐을 수 있으니 해당 현장의 현재 날짜를 확인하고 다시 요청해 주세요.';
    }
    return `✅ 체크리스트의 ${result.phase} 날짜를 변경했어요.\n📍 ${result.address}\n${p.oldDate || '미입력'} → ${result.date}\n공정 캘린더를 새로고침하면 반영돼요.`;
  }
  if(p.op==='create'){
    const r = await gasCall({ action:'cal_create', title:p.event.title||'', date:p.event.date||'', start:p.event.start||'', end:p.event.end||'', allDay:p.event.allDay?'1':'', category:p.event.category||'', guests:(p.event.guests||[]).join(','), names:(p.event.names||[]).join(',') });
    const res = r?.result;
    if(!res?.ok) return gasFailure(r, '일정 추가를 완료하지 못했어요.');
    const ev2 = {...p.event, guests: res.guests||p.event.guests, names: []};
    let msg = `✅ 추가했어요!\n${fmtEvent(ev2)}`;
    const probs = [];
    if(res.notFound?.length) probs.push(`'${res.notFound.join(", ")}'은(는) 디렉터리에서 못 찾았어요`);
    if(res.ambiguous?.length) probs.push(`'${res.ambiguous.join(", ")}'은(는) 동명이인이 있어 못 정했어요`);
    if(res.failedGuests?.length) probs.push(`'${res.failedGuests.join(', ')}' 참석자 추가에 실패했어요`);
    if(probs.length) msg += `\n⚠️ 일정은 만들어졌지만 ${probs.join(' / ')}. 캘린더에서 참석자를 확인해 주세요.`;
    return msg;
  }
  if(p.op==='delete'){
    const r = await gasCall({ action:'cal_delete', id:p.id, calId:p.calId||'' });
    return r?.result?.ok ? `🗑️ 삭제했어요: ${p.summary}` : gasFailure(r, '일정 삭제를 완료하지 못했어요.');
  }
  if(p.op==='site_add'){
    const r = await gasCall(Object.assign({ action:'site_add' }, p.site));
    return r?.result?.ok ? `✅ 현장을 추가했어요! (진행상태: 제안)\n${fmtSite(p.site)}` : gasFailure(r, '현장 추가를 완료하지 못했어요.');
  }
  if(p.op==='site_status'){
    if (typeof p.siteRef !== 'string' || !p.siteRef) return '⚠️ 현장 확인 정보가 만료되었거나 이전 방식으로 저장되어 있어요. Apps Script를 수정본으로 갱신하고 현장을 다시 검색해 주세요.';
    const r = await gasCall({ action:'site_status', siteRef:p.siteRef, status:p.status });
    const res = r?.result;
    if(!res?.ok) return gasFailure(r, '상태 변경을 완료하지 못했어요.');
    let msg = `✅ 상태를 "${res.status}"로 바꿨어요: ${p.summary}`;
    if(res.code) msg += `\n🏷️ 현장코드: ${res.code}`;
    return msg;
  }
  if(p.op==='update_many'){
    const c = p.changes;
    const r = await gasCall({ action:'cal_update_many', items: JSON.stringify(p.items), title:c.title||'', date:c.date||'', start:c.start||'', end:c.end||'', allDay:c.allDay||'' });
    return calendarBatchReply(r, '수정');
  }
  if(p.op==='delete_many'){
    const r = await gasCall({ action:'cal_delete_many', items: JSON.stringify(p.items) });
    return calendarBatchReply(r, '삭제');
  }
  if(p.op==='update'){
    const c = p.changes;
    const r = await gasCall({ action:'cal_update', id:p.id, calId:p.calId||'', title:c.title||'', date:c.date||'', start:c.start||'', end:c.end||'', allDay:c.allDay||'' });
    return r?.result?.ok ? `✏️ 수정했어요: ${p.summary}` : gasFailure(r, '일정 수정을 완료하지 못했어요.');
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
function gasDeploymentHint(){
  const match = String(GAS_URL || '').match(/\/s\/([A-Za-z0-9_-]+)\/exec(?:[?#]|$)/);
  return match ? '연결된 배포 ID 끝: …' + match[1].slice(-8) : 'GAS_URL에 Apps Script 웹앱 실행 주소(/exec)를 지정해 주세요.';
}
async function diagnoseGasConnection(){
  const response = await gasCall({action:'site_schedule_find',q:'__aqara_connection_probe_no_site__',phase:'조명설치'});
  const lines = ['비서 버전: ' + BOT_VERSION, gasDeploymentHint()];
  if(response?.error || response?.result?.error) lines.push(gasFailure(response, 'Apps Script 연결을 확인하지 못했어요.'));
  else if(response?.scheduleApiVersion === 1 && Array.isArray(response.result)){
    lines.push('✅ 체크리스트 공정일 API 연결 정상. 날짜나 번호는 변경하지 않았어요.');
    lines.push(response.scheduleBatchApiVersion === 1 ? '✅ 여러 공정 한 번 확인 기능 연결 정상.' : '여러 공정 일괄 변경은 Apps Script 2026-09-29c 배포 후 사용할 수 있어요.');
  }
  else if(response?.scheduleApiVersion === 1) lines.push('⚠️ 공정일 API는 응답했지만 검색 결과 형식을 확인해야 해요.');
  else lines.push('⚠️ 현재 연결된 주소에서 공정일 API 버전을 확인하지 못했어요. Render의 GAS_URL이 갱신한 웹앱 주소와 같은지 확인해 주세요.');
  return lines.join('\n');
}
function decodeGasResponse(data, writing){
  if(typeof data === 'string'){
    try { data = JSON.parse(data); }
    catch {
      return {error:'Apps Script가 JSON 데이터 대신 웹페이지나 다른 형식으로 응답했어요. GAS_URL의 /exec 주소와 웹앱 접근 권한을 확인해 주세요.' +
        (writing ? ' 변경이 반영됐을 수 있으니 현재 값을 확인한 뒤 다시 요청해 주세요.' : ''),code:'GAS_NON_JSON'};
    }
  }
  if(!data || typeof data !== 'object' || Array.isArray(data)){
    return {error:'Apps Script 응답 형식을 확인하지 못했어요.' + (writing ? ' 변경이 반영됐을 수 있으니 현재 값을 확인해 주세요.' : ''),code:'GAS_BAD_RESPONSE'};
  }
  return data;
}
function gasFailure(response, fallback){
  const result = response?.result;
  const reason = response?.error || result?.error;
  let text = `⚠️ ${fallback}`;
  if (result?.partial) text += ` 일부 변경${result.changed?.length ? `(${result.changed.join(', ')})` : ''}은 반영됐어요. 현재 내용을 확인해 주세요.`;
  if (reason) text += `\n${String(reason)}`;
  return text;
}
function calendarBatchReply(response, verb){
  const result = response?.result;
  if (!result || !Number.isInteger(result.count)) return gasFailure(response, `일정 일괄 ${verb}을 완료하지 못했어요.`);
  if (result.ok) return `✅ ${result.count}개 일정을 ${verb}했어요.`;
  const failed = Number.isInteger(result.failed) ? result.failed : (result.failures || []).length;
  const reasons = [...new Set((result.failures || []).map(f=>f.error).filter(Boolean))];
  return `⚠️ 일정 ${verb}: 완료 ${result.count}개 / 실패 ${failed}개.` +
    ((result.failures || []).some(f=>f.partial) ? ' 실패한 일정 중 일부 항목이 변경된 일정이 있어요. 캘린더에서 확인해 주세요.' : '') +
    (reasons.length ? `\n${reasons.join('\n')}` : '');
}
function uncertainGasWrite(response){
  return ['GAS_WRITE_UNCERTAIN','GAS_NON_JSON','GAS_BAD_RESPONSE'].includes(response?.code);
}
async function recheckSiteSchedule(p){
  const items = p.op === 'site_schedule_many' ? p.items : [p];
  const grouped = new Map();
  items.forEach(item=>{
    const address = item.address || p.address;
    if(!address) return;
    if(!grouped.has(address)) grouped.set(address,[]);
    const phases = grouped.get(address);
    if(!phases.includes(item.phase)) phases.push(item.phase);
  });
  const observations = new Map(await Promise.all([...grouped].map(async ([address,phases])=>
    [address,await findSiteScheduleGroups(address,phases,{timeout:7000})])));
  const checks = items.map(item=>{
    const address = item.address || p.address, vendor = item.vendor ?? p.vendor;
    const rows = observations.get(address)?.groups?.find(group=>group.phase === item.phase)?.rows;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    return {item,row:row && row.address === address && (vendor == null || row.vendor === vendor) ? row : null};
  });
  const allMatch = checks.length > 0 && checks.every(({item,row})=>row && row.date === item.date);
  const lines = checks.map(({item,row})=>row
    ? `• ${item.phase}: 현재 ${row.date || '미입력'}${row.date === item.date ? ' (요청한 날짜와 같음)' : ` / 요청 ${item.date}`}`
    : `• ${item.phase}: 현재 날짜를 확인하지 못했어요. / 요청 ${item.date}`);
  return (allMatch ? '✅ 다시 조회한 현재 날짜가 요청한 내용과 같아요.' : '⚠️ 변경 응답을 받지 못해 현재 날짜를 다시 조회했어요.') +
    `\n📍 ${p.address || items[0]?.address || p.summary || ''}\n` + lines.join('\n') +
    (allMatch ? '\n공정 캘린더를 새로고침해 주세요.' : '\n변경 요청이 아직 끝나지 않았을 수 있어요. 잠시 후 현재 내용을 확인해 주세요.');
}
async function gasCall(extra, options = {}){
  const writing = /^(site_add|site_status|site_schedule_update|site_schedule_update_many|cal_create|cal_update|cal_delete|cal_update_many|cal_delete_many)$/.test(extra?.action || '');
  if(!GAS_URL || !GAS_TOKEN) return {error:'Render 환경변수 GAS_URL과 GAS_TOKEN 설정을 확인해 주세요.',code:'GAS_CONFIG_MISSING'};
  const clean = {}; Object.keys(extra||{}).forEach(k=>{ if(extra[k]!=null) clean[k]=extra[k]; });
  const params = new URLSearchParams({ token:GAS_TOKEN, ...clean });
  const readable = ['calendar','gmail','drive','sheet','cal_search','site_find','site_schedule_find','site_schedule_find_many','site_code_policy'].includes(extra?.action);
  const requestedTimeout = Number(options.timeout);
  const maxBudget = /^site_schedule_find(?:_many)?$/.test(extra?.action || '') ? 25000 : 20000;
  const budget = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout,maxBudget) : 20000;
  const started = Date.now();
  for(let attempt=0;attempt<2;attempt++){
    try {
      const config = {maxRedirects:5,timeout:attempt ? Math.max(1,budget - Math.max(0,Date.now()-started)) : budget};
      const { data } = extra?.action === 'site_schedule_update_many'
        ? await axios.post(GAS_URL.trim(),params.toString(),{...config,headers:{'Content-Type':'application/x-www-form-urlencoded'}})
        : await axios.get(`${GAS_URL.trim()}?${params.toString()}`,config);
      const decoded = decodeGasResponse(data, writing);
      if(decoded?.code === 'GAS_NON_JSON' || decoded?.code === 'GAS_BAD_RESPONSE'){
        logGasTransportFailure(extra?.action,{code:decoded.code},Date.now()-started);
      }
      return decoded;
    } catch (err) {
      const elapsed = Math.max(0,Date.now()-started);
      logGasTransportFailure(extra?.action,err,elapsed);
      // 조회 재시도도 같은 제한시간 안에서만 수행한다. 응답 유실 가능성이 있는 쓰기는 한 번만 보낸다.
      if(!attempt && readable && options.retry !== false && !err?.response &&
        ['ECONNABORTED','ETIMEDOUT','ECONNRESET'].includes(err?.code) && budget-elapsed >= 1000) continue;
      if(!writing && [401,403,404].includes(err?.response?.status)) return {error:`Apps Script 접근에 실패했어요 (HTTP ${err.response.status}). GAS_URL과 웹앱 배포의 접근 권한을 확인해 주세요.`,code:'GAS_ACCESS'};
      return { code:writing ? 'GAS_WRITE_UNCERTAIN' : 'GAS_READ_FAILED', error: writing ? '서버 응답을 확인하지 못했습니다. 작업이 반영됐을 수 있으니 중복 요청 전에 시트나 캘린더를 확인해 주세요.' : '서버 응답을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.' };
    }
  }
}
function logGasTransportFailure(action, error, elapsed){
  const actions = ['calendar','gmail','drive','sheet','cal_search','site_find','site_schedule_find','site_schedule_find_many',
    'site_code_policy','site_add','site_status','site_schedule_update','site_schedule_update_many','cal_create','cal_update','cal_delete','cal_update_many','cal_delete_many'];
  const codes = ['ECONNABORTED','ETIMEDOUT','ECONNRESET','ENOTFOUND','EAI_AGAIN','ERR_NETWORK','ERR_BAD_REQUEST','ERR_BAD_RESPONSE','GAS_NON_JSON','GAS_BAD_RESPONSE'];
  const status = Number(error?.response?.status);
  console.warn('[gas]',JSON.stringify({action:actions.includes(action) ? action : 'unknown',
    status:Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
    code:codes.includes(error?.code) ? error.code : 'UNKNOWN',elapsed:Math.max(0,Number(elapsed) || 0)}));
}
async function gasCalSearch(date, keyword, dateTo){
  const d = await gasCall({ action:'cal_search', date:date||'', dateTo:dateTo||'', keyword:keyword||'' });
  if (!Array.isArray(d?.result)) throw new Error(d?.error || d?.result?.error || '일정 검색 응답을 확인할 수 없습니다.');
  return d.result;
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
  if (gas?.error || gas?.result?.error) return gasFailure(gas, '조회 요청을 완료하지 못했어요.');
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`server on :${PORT}`));

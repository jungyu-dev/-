/*** 카카오+슬랙+구글챗 비서 서버 (Gemini · 스마트검색 · 대화기억 A) **********
 * 두뇌: parseIntent(맥락+의도+검색식) → fetchGas / chat → summarize
 * 대화기억: 서버 메모리에 사용자별 최근 N턴 저장 (서버 재시작 시 초기화)
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
const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
});

/* ===== 대화 기억 (서버 메모리) ===== */
const HISTORY = new Map();   // userKey -> [{role, text}, ...]
const MAX_TURNS = 6;         // user+assistant 합쳐 6개 ≈ 최근 3턴
function getHistory(key) { return (key && HISTORY.get(key)) || []; }
function pushHistory(key, role, text) {
  if (!key) return;
  const arr = HISTORY.get(key) || [];
  arr.push({ role, text: String(text).slice(0, 300) });
  while (arr.length > MAX_TURNS) arr.shift();
  HISTORY.set(key, arr);
}
function historyText(history) {
  if (!history.length) return '(없음)';
  return history.map(h => `${h.role === 'user' ? '사용자' : '비서'}: ${h.text}`).join('\n');
}

/* ===== AI 호출 (503/429/500 자동 재시도) ===== */
async function askAI(prompt, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await model.generateContent(prompt);
      return r.response.text();
    } catch (e) {
      const status = e?.status || e?.response?.status;
      if ((status === 503 || status === 429 || status === 500) && i < tries - 1) {
        console.warn(`[retry] ${status} \u2014 ${1.5 * (i + 1)}s 후 재시도 (${i + 1}/${tries - 1})`);
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

app.get('/', (_req, res) => res.send('skill server ok'));

/* ===== 카카오 ===== */
app.post('/skill', (req, res) => {
  const ur = req.body?.userRequest || {};
  const key = ur.user?.id || null;
  res.json({ version: '2.0', useCallback: true,
    data: { text: '🤔 잠깐만요, 확인하고 있어요…' } });
  if (!ur.callbackUrl) return;
  handleAsync(ur.utterance || '', key)
    .then((t) => sendKakao(ur.callbackUrl, t))
    .catch(async (e) => { console.error('[kakao]', e?.message || e);
      await sendKakao(ur.callbackUrl, '⚠️ 처리 중 오류가 났어요.').catch(() => {}); });
});

/* ===== 슬랙 ===== */
app.post('/slack', (req, res) => {
  const text = req.body?.text || '';
  const key = req.body?.user_id || null;
  const responseUrl = req.body?.response_url;
  res.json({ response_type: 'ephemeral', text: '🤔 잠깐만요, 확인하고 있어요…' });
  if (!responseUrl) return;
  handleAsync(text, key)
    .then((t) => postSlack(responseUrl, t))
    .catch(async (e) => { console.error('[slack]', e?.message || e);
      await postSlack(responseUrl, '⚠️ 처리 중 오류가 났어요.').catch(() => {}); });
});

/* ===== 구글 챗 (동기 응답) ===== */
app.post('/gchat', async (req, res) => {
  const event = req.body || {};
  if (event.type !== 'MESSAGE') {
    return res.json({ text: '안녕하세요! 일정·메일·드라이브·시트를 봐드릴게요. 무엇을 도와드릴까요?' });
  }
  const key = event.user?.name || event.message?.sender?.name || null;
  const text = (event.message?.text || '').replace(/^@\S+\s*/, '');
  try { res.json({ text: await handleAsync(text, key) }); }
  catch (e) { console.error('[gchat]', e?.message || e);
    res.json({ text: '⚠️ 처리 중 오류가 났어요.' }); }
});

/* ===== 공통 두뇌 ===== */
async function handleAsync(utterance, key) {
  const history = getHistory(key);
  const intent = await parseIntent(utterance, history);
  let reply;
  if (intent.action === 'chat') {
    reply = await chat(utterance, history);
  } else {
    const gas = await fetchGas(intent);
    reply = await summarize(utterance, gas, history);
  }
  pushHistory(key, 'user', utterance);
  pushHistory(key, 'assistant', reply);
  return reply;
}

async function parseIntent(utterance, history) {
  const now = new Date();
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const weekday = now.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'long' });
  const prompt =
`오늘은 ${today} (${weekday}), Asia/Seoul. 아래 '직전 대화'를 참고해 '이번 발화'를 분석하고 JSON 한 줄만 출력해.

[직전 대화]
${historyText(history)}

[이번 발화]
"${utterance}"

형식: {"action":"calendar|gmail|drive|sheet|chat","from":"yyyy-mm-dd|null","to":"yyyy-mm-dd|null","gmailQuery":"<Gmail검색식|null>","driveQuery":"<Drive검색식|null>","keyword":"<시트 이름 키워드|null>"}

[맥락 이어받기] 이번 발화가 "그중에서","그건","아까 그거","PDF로 된 거","안 읽은 것만" 처럼 앞을 가리키면, 직전 대화의 대상/조건을 이어받아 검색식을 완성해. (예: 직전에 '교육바이블 파일' 얘기 → "PDF로 된 거" → driveQuery에 교육바이블 + PDF 둘 다 반영)

[분류] 일정→calendar, 메일→gmail, 드라이브/파일→drive, 시트/엑셀→sheet, 인사·잡담·불가능한 요청→chat

[calendar] 날짜를 from/to로. "오늘"→from=to=오늘. 하루면 from=to 동일. "이번주/다음주/주말/이번달"은 범위. 없으면 null.
[gmail] gmailQuery = Gmail 검색식. from:이름 / is:unread / has:attachment / newer_than:3d 등. 예) "조형민 어제 메일"→"from:조형민 newer_than:2d". 막연하면 null.
[drive] driveQuery = Drive 검색식. title contains '단어' / mimeType = 'application/pdf' / mimeType = 'application/vnd.google-apps.spreadsheet' 등을 and로 조합. (trashed 조건은 넣지 마.) 예) "보고서 PDF"→"title contains '보고서' and mimeType = 'application/pdf'". 막연하면 null.
[sheet] keyword = 시트 이름 핵심 단어. 없으면 null.

해당 없는 필드는 null. 설명·코드블록 없이 JSON 한 줄만.`;
  try {
    const txt = (await askAI(prompt)).replace(/```json|```/g, '').trim();
    const o = JSON.parse(txt);
    const ok = ['calendar', 'gmail', 'drive', 'sheet', 'chat'];
    const c = (v) => (v && v !== 'null' ? v : null);
    return {
      action: ok.includes(o.action) ? o.action : 'chat',
      from: c(o.from), to: c(o.to),
      gmailQuery: c(o.gmailQuery), driveQuery: c(o.driveQuery), keyword: c(o.keyword),
    };
  } catch {
    return { action: 'chat', from: null, to: null, gmailQuery: null, driveQuery: null, keyword: null };
  }
}

async function chat(utterance, history) {
  const prompt =
`너는 준규 님의 다정하고 센스있는 업무 비서야.
[직전 대화]
${historyText(history)}
[이번 발화]
"${utterance}"
규칙: 짧고 친근하게(2~3문장), 이모지 약간. 할 수 있는 일은 '구글 캘린더/지메일/드라이브/시트' 조회·요약. 못 하는 요청이면 살짝 사과하고 할 수 있는 걸 안내. 인사면 반갑게.`;
  return (await askAI(prompt)).slice(0, 980);
}

async function fetchGas(intent) {
  const params = new URLSearchParams({ token: GAS_TOKEN, action: intent.action });
  if (intent.action === 'calendar') {
    if (intent.from) params.set('from', intent.from);
    if (intent.to)   params.set('to', intent.to);
  } else if (intent.action === 'gmail') {
    if (intent.gmailQuery) params.set('q', intent.gmailQuery);
  } else if (intent.action === 'drive') {
    if (intent.driveQuery) params.set('q', intent.driveQuery);
  } else if (intent.action === 'sheet') {
    if (intent.keyword) params.set('keyword', intent.keyword);
  }
  const { data } = await axios.get(`${GAS_URL}?${params.toString()}`,
    { maxRedirects: 5, timeout: 20000 });
  return data;
}

async function summarize(utterance, gas, history) {
  const prompt =
`너는 준규 님의 업무 비서야. 아래 구글 데이터를 보고 메신저 말풍선용 한국어 브리핑을 써.
[직전 대화] ${historyText(history)}
[이번 요청] "${utterance}"
[데이터(JSON)] ${JSON.stringify(gas).slice(0, 7000)}
규칙: 핵심만, 항목은 줄바꿈으로, 이모지 약간, 인사말 없이 바로, 950자 이내.
- 메일이면 보낸사람/제목 위주로, 안읽음(unread:true)은 표시.
- 드라이브는 파일명/수정일 위주로. 이번 요청이 앞 대화를 이어받은 거면 그 맥락에 맞게.
- 결과가 비면 "해당 조건엔 없네요" 식으로 자연스럽게, 어떤 조건으로 찾았는지 한 줄.`;
  return (await askAI(prompt)).slice(0, 980);
}

/* ===== 출구 ===== */
async function sendKakao(callbackUrl, text) {
  await axios.post(callbackUrl,
    { version: '2.0', template: { outputs: [{ simpleText: { text } }] } },
    { timeout: 10000 });
}
async function postSlack(responseUrl, text) {
  await axios.post(responseUrl, { response_type: 'ephemeral', text }, { timeout: 10000 });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server on :${PORT}`));

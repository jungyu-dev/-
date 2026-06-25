/*** 카카오 + 슬랙 + 구글챗 겸용 비서 서버 (Gemini, 스마트 검색 버전) ********
 * 두뇌: parseIntent(의도+날짜+검색조건) → fetchGas / chat → summarize
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
  res.json({ version: '2.0', useCallback: true,
    data: { text: '🤔 잠깐만요, 확인하고 있어요…' } });
  if (!ur.callbackUrl) return;
  handleAsync(ur.utterance || '')
    .then((t) => sendKakao(ur.callbackUrl, t))
    .catch(async (e) => { console.error('[kakao]', e?.message || e);
      await sendKakao(ur.callbackUrl, '⚠️ 처리 중 오류가 났어요.').catch(() => {}); });
});

/* ===== 슬랙 ===== */
app.post('/slack', (req, res) => {
  const text = req.body?.text || '';
  const responseUrl = req.body?.response_url;
  res.json({ response_type: 'ephemeral', text: '🤔 잠깐만요, 확인하고 있어요…' });
  if (!responseUrl) return;
  handleAsync(text)
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
  const text = (event.message?.text || '').replace(/^@\S+\s*/, '');
  try { res.json({ text: await handleAsync(text) }); }
  catch (e) { console.error('[gchat]', e?.message || e);
    res.json({ text: '⚠️ 처리 중 오류가 났어요.' }); }
});

/* ===== 공통 두뇌 ===== */
async function handleAsync(utterance) {
  const intent = await parseIntent(utterance);
  if (intent.action === 'chat') return chat(utterance);
  const gas = await fetchGas(intent);
  return summarize(utterance, gas);
}

async function parseIntent(utterance) {
  const now = new Date();
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const weekday = now.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'long' });
  const prompt =
`오늘은 ${today} (${weekday}), Asia/Seoul. 사용자 발화를 분석해 JSON 한 줄만 출력해.
발화: "${utterance}"
형식: {"action":"calendar|gmail|drive|sheet|chat","from":"yyyy-mm-dd|null","to":"yyyy-mm-dd|null","gmailQuery":"<Gmail검색식|null>","keyword":"<드라이브/시트 키워드|null>"}
[분류]
- 일정/약속/미팅/스케줄 → calendar
- 메일/이메일/답장/받은편지 → gmail
- 드라이브/파일/문서/작업물 → drive
- 시트/엑셀/표/스프레드시트 → sheet
- 인사·잡담, 또는 위 4종으로 불가능한 요청(메일 보내기, 일정 추가, 날씨, 검색 등) → chat
[calendar] 날짜를 from/to로. "오늘"→from=to=오늘. "내일/모레/특정일/요일" 하루면 from=to 동일. "이번주/다음주/주말/이번달"은 범위. 없으면 둘 다 null.
[gmail] gmailQuery를 Gmail 검색 연산자로 작성:
  - 발신자: from:이름 / 안읽음: is:unread / 첨부: has:attachment / 기간: newer_than:3d, older_than:7d
  - 특정 조건 없으면 그냥 안읽은 메일이면 "is:unread", 막연하면 null.
  - 예) "조형민한테 어제 온 메일" → "from:조형민 newer_than:2d"
  - 예) "안 읽은 메일 몇 개" → "is:unread"
  - 예) "첨부파일 있는 메일" → "has:attachment newer_than:14d"
[drive/sheet] keyword = 파일/시트 이름에서 찾을 핵심 단어 하나. 없으면 null. 예) "매출 시트" → "매출"
calendar가 아니면 from,to는 null. 해당 없는 필드는 null. 설명·코드블록 없이 JSON 한 줄만.`;
  try {
    const txt = (await askAI(prompt)).replace(/```json|```/g, '').trim();
    const o = JSON.parse(txt);
    const ok = ['calendar', 'gmail', 'drive', 'sheet', 'chat'];
    const clean = (v) => (v && v !== 'null' ? v : null);
    return {
      action: ok.includes(o.action) ? o.action : 'chat',
      from: clean(o.from), to: clean(o.to),
      gmailQuery: clean(o.gmailQuery), keyword: clean(o.keyword),
    };
  } catch {
    return { action: 'chat', from: null, to: null, gmailQuery: null, keyword: null };
  }
}

async function chat(utterance) {
  const prompt =
`너는 준규 님의 다정하고 센스있는 업무 비서야. 사용자가 인사·잡담을 했거나, 네가 할 수 없는 요청을 했어.
발화: "${utterance}"
규칙:
- 짧고 친근한 대화체, 이모지 약간. 2~3문장 이내.
- 할 수 있는 일은 '구글 캘린더 / 지메일 / 드라이브 / 시트' 조회·요약.
- 못 하는 요청이면 살짝 사과하고 할 수 있는 걸 안내. 인사면 반갑게 받아줘.`;
  return (await askAI(prompt)).slice(0, 980);
}

async function fetchGas(intent) {
  const params = new URLSearchParams({ token: GAS_TOKEN, action: intent.action });
  if (intent.action === 'calendar') {
    if (intent.from) params.set('from', intent.from);
    if (intent.to)   params.set('to', intent.to);
  } else if (intent.action === 'gmail') {
    if (intent.gmailQuery) params.set('q', intent.gmailQuery);
  } else if (intent.action === 'drive' || intent.action === 'sheet') {
    if (intent.keyword) params.set('keyword', intent.keyword);
  }
  const { data } = await axios.get(`${GAS_URL}?${params.toString()}`,
    { maxRedirects: 5, timeout: 20000 });
  return data;
}

async function summarize(utterance, gas) {
  const prompt =
`너는 준규 님의 업무 비서야. 아래 구글 데이터를 보고 메신저 말풍선용 한국어 브리핑을 써.
사용자 요청: "${utterance}"
데이터(JSON): ${JSON.stringify(gas).slice(0, 7000)}
규칙: 핵심만, 항목은 줄바꿈으로, 이모지 약간, 인사말 없이 바로, 950자 이내.
- 메일이면 보낸사람/제목 위주로, 안읽음(unread:true)은 표시해줘.
- 데이터가 비어 있으면 "해당 조건엔 없네요" 식으로 자연스럽게. 검색 결과가 없을 땐 어떤 조건으로 찾았는지 한 줄 덧붙여.`;
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

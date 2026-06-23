/*** 카카오 + 슬랙 + 구글챗 겸용 비서 서버 (Gemini 버전, Express on Render) ***
 * /skill  → 카카오 (콜백: 즉시 ACK 후 callbackUrl로 최종 응답)
 * /slack  → 슬랙 슬래시 명령 (즉시 ACK 후 response_url로 최종 응답)
 * /gchat  → 구글 챗 (응답 제한 30초라 동기 응답)
 *
 * 두뇌: parseIntent(의도+날짜+잡담분류) → fetchGas / chat → summarize
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

/* ===== AI 호출 (503 혼잡 / 429 한도 / 500 시 자동 재시도) ===== */
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

/* ===== 구글 챗 (동기 응답, 30초 제한 내) ===== */
app.post('/gchat', async (req, res) => {
  const event = req.body || {};
  if (event.type !== 'MESSAGE') {
    return res.json({ text: '안녕하세요! 일정·메일·드라이브·시트를 봐드릴게요. 무엇을 도와드릴까요?' });
  }
  const text = (event.message?.text || '').replace(/^@\S+\s*/, '');
  try {
    res.json({ text: await handleAsync(text) });
  } catch (e) {
    console.error('[gchat]', e?.message || e);
    res.json({ text: '⚠️ 처리 중 오류가 났어요.' });
  }
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
형식: {"action":"calendar|gmail|drive|sheet|chat","from":"yyyy-mm-dd|null","to":"yyyy-mm-dd|null"}
[분류]
- 일정/약속/미팅/스케줄/"뭐 있어/뭐 하지" → calendar
- 메일/이메일/답장/받은편지 → gmail
- 드라이브/파일/문서/작업물 → drive
- 시트/엑셀/표/스프레드시트 → sheet
- 인사·잡담·감사, 또는 위 4종으로 처리 불가능한 요청(메일 보내기, 일정 추가/수정, 날씨, 검색 등) → chat
[날짜] action이 calendar일 때만 채움:
- "오늘" → from=to=오늘. "내일/모레" 등 상대 표현 변환.
- "6월 24일","6/24","24일","화요일","다음주 월요일" 같은 특정/상대 하루 → 그 날짜로 from=to 동일하게.
- "이번주","다음주","주말","이번달" → 해당 범위의 시작/끝으로 from/to.
- 날짜 언급 없으면 from,to 모두 null.
설명·코드블록 없이 JSON 한 줄만.`;
  try {
    const txt = (await askAI(prompt)).replace(/```json|```/g, '').trim();
    const o = JSON.parse(txt);
    const ok = ['calendar', 'gmail', 'drive', 'sheet', 'chat'];
    return {
      action: ok.includes(o.action) ? o.action : 'chat',
      from: o.from && o.from !== 'null' ? o.from : null,
      to:   o.to   && o.to   !== 'null' ? o.to   : null,
    };
  } catch {
    return { action: 'chat', from: null, to: null };
  }
}

/* 인사·잡담·범위 밖 요청 → 비서답게 대화 */
async function chat(utterance) {
  const prompt =
`너는 준규 님의 다정하고 센스있는 업무 비서야. 사용자가 인사·잡담을 했거나, 네가 할 수 없는 요청을 했어.
발화: "${utterance}"
규칙:
- 짧고 친근한 대화체로. 이모지 약간만.
- 네가 할 수 있는 일은 '구글 캘린더 일정 / 지메일 메일 / 드라이브 파일 / 구글 시트' 조회·요약이야.
- 못 하는 요청(메일 보내기, 일정 추가, 날씨 등)이면 살짝 사과하고 할 수 있는 걸 자연스럽게 안내해.
- 단순 인사면 반갑게 받아주고, 필요하면 도울 수 있다고 가볍게 덧붙여.
- 2~3문장 이내로 짧게.`;
  return (await askAI(prompt)).slice(0, 980);
}

async function fetchGas(intent) {
  const params = new URLSearchParams({ token: GAS_TOKEN, action: intent.action });
  if (intent.action === 'calendar') {
    if (intent.from) params.set('from', intent.from);
    if (intent.to)   params.set('to', intent.to);
  }
  const { data } = await axios.get(`${GAS_URL}?${params.toString()}`,
    { maxRedirects: 5, timeout: 20000 });
  return data;
}

async function summarize(utterance, gas) {
  const prompt =
`너는 준규 님의 업무 비서야. 아래 구글 데이터를 보고 메신저 말풍선용 한국어 브리핑을 써.
사용자 요청: "${utterance}"
데이터(JSON): ${JSON.stringify(gas).slice(0, 6000)}
규칙: 핵심만, 항목은 줄바꿈으로, 이모지 약간, 인사말 없이 바로, 950자 이내. 데이터가 비어 있으면 "해당 기간엔 없네요" 식으로 자연스럽게.`;
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

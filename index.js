/*** 카카오 + 슬랙 겸용 비서 서버 (Express on Render) *********************
 * /skill  → 카카오 스킬 (콜백 모드: 즉시 ACK 후 callbackUrl로 최종 응답)
 * /slack  → 슬랙 슬래시 명령 (즉시 ACK 후 response_url로 최종 응답)
 * 두 입구가 같은 두뇌(parseIntent → fetchGas → summarize)를 공유한다.
 *
 * Render 환경변수: GAS_URL, GAS_TOKEN, GEMINI_API_KEY, GEMINI_MODEL
 *********************************************************************/
import express from 'express';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());                          // 카카오용 (JSON 바디)
app.use(express.urlencoded({ extended: true }));  // 슬랙 슬래시 명령용 (폼 바디)

const GAS_URL   = process.env.GAS_URL;
const GAS_TOKEN = process.env.GAS_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
});

app.get('/', (_req, res) => res.send('skill server ok'));

/* ===== 카카오 스킬 엔드포인트 ===== */
app.post('/skill', (req, res) => {
  const ur = req.body?.userRequest || {};
  const utterance   = ur.utterance || '';
  const callbackUrl = ur.callbackUrl;

  // 5초 안에 즉시 ACK (콜백 모드)
  res.json({
    version: '2.0',
    useCallback: true,
    data: { text: '📋 데이터 보고 있어요… 5~15초만 기다려 주세요!' },
  });

  if (!callbackUrl) {
    console.warn('[kakao] callbackUrl 없음 (AI챗봇 전환 + 배포 채널에서만 동작)');
    return;
  }
  handleAsync(utterance)
    .then((text) => sendKakao(callbackUrl, text))
    .catch(async (err) => {
      console.error('[kakao async]', err?.message || err);
      await sendKakao(callbackUrl, '⚠️ 처리 중 오류가 났어요.').catch(() => {});
    });
});

/* ===== 슬랙 슬래시 명령 엔드포인트 ===== */
app.post('/slack', (req, res) => {
  const text        = req.body?.text || '';          // 명령어 뒤에 친 내용
  const responseUrl = req.body?.response_url;         // 지연 응답용 (30분 유효)

  // 3초 안에 즉시 ACK ('ephemeral' = 본인에게만 보임)
  res.json({ response_type: 'ephemeral', text: '📋 데이터 보고 있어요… 잠시만요!' });

  if (!responseUrl) {
    console.warn('[slack] response_url 없음');
    return;
  }
  handleAsync(text)
    .then((out) => postSlack(responseUrl, out))
    .catch(async (err) => {
      console.error('[slack async]', err?.message || err);
      await postSlack(responseUrl, '⚠️ 처리 중 오류가 났어요.').catch(() => {});
    });
});

/* ===== 공통 두뇌 파이프라인 ===== */
async function handleAsync(utterance) {
  const intent = await parseIntent(utterance);  // 의도 + 날짜
  const gas    = await fetchGas(intent);        // 구글 데이터
  return summarize(utterance, gas);             // 한국어 브리핑
}

async function parseIntent(utterance) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const prompt =
`오늘은 ${today} (Asia/Seoul). 아래 발화를 분석해 JSON 한 줄만 출력해.
발화: "${utterance}"
형식: {"action":"calendar|gmail|drive|sheet","from":"yyyy-mm-dd|null","to":"yyyy-mm-dd|null"}
규칙:
- 일정/캘린더/미팅→calendar, 메일/지메일→gmail, 드라이브/파일→drive, 시트/엑셀→sheet.
- "오늘","내일","모레","이번주","6월 22일","06/25" 등을 from/to 날짜로 변환. 날짜 없으면 둘 다 null.
- 코드블록·설명 금지. JSON 한 줄만.`;
  try {
    const r = await model.generateContent(prompt);
    const txt = r.response.text().replace(/```json|```/g, '').trim();
    const obj = JSON.parse(txt);
    return {
      action: obj.action || 'calendar',
      from: obj.from && obj.from !== 'null' ? obj.from : null,
      to:   obj.to   && obj.to   !== 'null' ? obj.to   : null,
    };
  } catch {
    return { action: 'calendar', from: null, to: null };
  }
}

async function fetchGas(intent) {
  const params = new URLSearchParams({ token: GAS_TOKEN, action: intent.action });
  if (intent.action === 'calendar') {
    if (intent.from) params.set('from', intent.from);
    if (intent.to)   params.set('to', intent.to);
  }
  const { data } = await axios.get(`${GAS_URL}?${params.toString()}`, {
    maxRedirects: 5,
    timeout: 20000,
  });
  return data;
}

async function summarize(utterance, gas) {
  const prompt =
`너는 준규 님의 업무 비서야. 아래 구글 데이터를 보고 메신저 말풍선용 한국어 브리핑을 써.
사용자 요청: "${utterance}"
데이터(JSON): ${JSON.stringify(gas).slice(0, 6000)}
규칙: 핵심만, 항목은 줄바꿈으로, 이모지 약간만, 인사말 없이 바로, 950자 이내.`;
  const r = await model.generateContent(prompt);
  return r.response.text().slice(0, 980);
}

/* ===== 출구 ===== */
async function sendKakao(callbackUrl, text) {
  await axios.post(
    callbackUrl,
    { version: '2.0', template: { outputs: [{ simpleText: { text } }] } },
    { timeout: 10000 },
  );
}
async function postSlack(responseUrl, text) {
  await axios.post(
    responseUrl,
    { response_type: 'ephemeral', text },
    { timeout: 10000 },
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server on :${PORT}`));

/*** 카카오 콜백 오케스트레이터 (Express on Render) **************************
 * 흐름:
 *   1) 카카오 스킬 요청 수신
 *   2) 5초 안에 즉시 ACK (useCallback:true, '분석 중' 말풍선)
 *   3) 응답 이후 비동기로: 제미나이 의도·날짜 파싱 → GAS 데이터 → 제미나이 요약
 *   4) userRequest.callbackUrl 로 최종 말풍선 POST (콜백 창 1분 이내)
 *
 * Render 환경변수:
 *   GAS_URL        구글 웹앱 /exec URL
 *   GAS_TOKEN      GAS의 SHARED_TOKEN 과 동일
 *   GEMINI_API_KEY 제미나이 API 키
 *   GEMINI_MODEL   (선택) 기본 gemini-2.5-flash
 *
 * package.json 에 "type":"module" 필요. 의존성: express, axios, @google/generative-ai
 ***************************************************************************/
import express from 'express';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());

const GAS_URL   = process.env.GAS_URL;
const GAS_TOKEN = process.env.GAS_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
});

app.get('/', (_req, res) => res.send('skill server ok'));

/* 카카오 스킬 엔드포인트 */
app.post('/skill', (req, res) => {
  const ur = req.body?.userRequest || {};
  const utterance   = ur.utterance || '';
  const callbackUrl = ur.callbackUrl;

  // ── ① 5초 안에 즉시 ACK (콜백 모드). template 필드는 넣지 않는다.
  res.json({
    version: '2.0',
    useCallback: true,
    data: { text: '📋 데이터 보고 있어요… 5~15초만 기다려 주세요!' },
  });

  // 봇테스트 등 콜백 미지원 환경이면 callbackUrl 이 없다 → 비동기 진행 불가
  if (!callbackUrl) {
    console.warn('[skip] callbackUrl 없음 (배포 채널 + AI챗봇 전환 시에만 동작)');
    return;
  }

  // ── ② 무거운 작업은 응답을 보낸 뒤 비동기로 실행
  handleAsync(utterance, callbackUrl).catch(async (err) => {
    console.error('[async error]', err?.message || err);
    await sendCallback(callbackUrl, '⚠️ 처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요.')
      .catch(() => {});
  });
});

async function handleAsync(utterance, callbackUrl) {
  const intent = await parseIntent(utterance);          // 1) 의도 + 날짜
  const gas    = await fetchGas(intent);                // 2) 구글 데이터
  const text   = await summarize(utterance, gas);       // 3) 한국어 브리핑
  await sendCallback(callbackUrl, text);                // 4) 최종 말풍선
}

/* 1) 제미나이로 의도 + 날짜 파싱 — 여기서 '6월 22일' 같은 자유 표현이 해결됨 */
async function parseIntent(utterance) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // yyyy-mm-dd
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
    return { action: 'calendar', from: null, to: null }; // 파싱 실패 시 안전 기본값
  }
}

/* 2) GAS 호출 — axios 가 302 를 자동 추적하므로 그대로 JSON 수신 */
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

/* 3) 제미나이로 카카오 말풍선용 한국어 브리핑 생성 */
async function summarize(utterance, gas) {
  const prompt =
`너는 준규 님의 업무 비서야. 아래 구글 데이터를 보고 카카오톡 말풍선용 한국어 브리핑을 써.
사용자 요청: "${utterance}"
데이터(JSON): ${JSON.stringify(gas).slice(0, 6000)}
규칙: 핵심만, 항목은 줄바꿈으로, 이모지 약간만, 인사말 없이 바로, 950자 이내.`;
  const r = await model.generateContent(prompt);
  return r.response.text().slice(0, 980); // 카카오 simpleText 길이 안전선
}

/* 4) 카카오 콜백 — 응답 포맷은 일반 스킬 응답과 동일 */
async function sendCallback(callbackUrl, text) {
  await axios.post(
    callbackUrl,
    { version: '2.0', template: { outputs: [{ simpleText: { text } }] } },
    { timeout: 10000 },
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`skill server on :${PORT}`));

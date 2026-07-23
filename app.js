/* =========================================================
   실시간 통역 자막 PWA
   - 스마트폰 마이크 → PCM16/16kHz 변환 → Gemini Live API(WebSocket)
   - 번역 결과 텍스트를 화면에 실시간 자막으로 표시
   ========================================================= */

const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ---- DOM ----
const micBtn = document.getElementById("micBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const captionArea = document.getElementById("captionArea");
const emptyState = document.getElementById("emptyState");
const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const apiKeyInput = document.getElementById("apiKey");
const targetLangSelect = document.getElementById("targetLang");
const modelSelect = document.getElementById("modelSelect");

// ---- State ----
let ws = null;
let sessionResumeHandle = null;
let reconnectingInProgress = false;
let audioCtx = null;
let sourceNode = null;
let processorNode = null;
let mediaStream = null;
let isRecording = false;
let currentCaptionEl = null;
let setupAcked = false;
let useMinimalSetup = false;

// ---- Firebase 중계 (폰 → 안경 자막 전송) ----
let fbDb = null;
let fbSession = null;

function parseFirebaseConfigInput(rawInput) {
  let raw = (rawInput || "")
    .trim()
    // 아이폰 등에서 붙여넣을 때 생길 수 있는 스마트 따옴표를 일반 따옴표로 교정
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  // 끝에 붙은 세미콜론(예: "...};") 제거
  raw = raw.replace(/;\s*$/, "").trim();
  // 앞뒤 중괄호가 빠졌으면 자동으로 보정
  if (!raw.startsWith("{")) raw = "{" + raw;
  if (!raw.endsWith("}")) raw = raw + "}";
  // 맨 끝 항목 뒤 불필요한 쉼표 제거 (trailing comma)
  raw = raw.replace(/,\s*}$/, "}");

  // 1) 표준 JSON 형식 시도
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 2) Firebase 콘솔이 보여주는 JS 객체 리터럴(키에 따옴표 없음) 형식 시도
    try {
      return Function('"use strict"; return (' + raw + ")")();
    } catch (e2) {
      return null;
    }
  }
}

function initFirebaseIfConfigured() {
  const raw = localStorage.getItem("fb_config");
  const session = localStorage.getItem("session_id") || "myroom01";
  fbSession = session;
  if (!raw) return;
  try {
    const config = JSON.parse(raw); // 저장 시 이미 표준 JSON으로 정규화해둠
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
    fbDb = firebase.database();
  } catch (e) {
    console.log("Firebase 설정 오류:", e);
    fbDb = null;
  }
}

let fbPendingText = null;
let fbPendingTimer = null;
const FB_MIN_INTERVAL_MS = 250;

function pushCaptionToGlasses(text, isFinal) {
  if (!fbDb || !fbSession) return;

  // 최종 확정 자막은 즉시 전송
  if (isFinal) {
    if (fbPendingTimer) {
      clearTimeout(fbPendingTimer);
      fbPendingTimer = null;
    }
    fbPendingText = null;
    writeCaption(text, true);
    return;
  }

  // 진행 중 자막은 잘게 쪼개져 수십 번씩 오므로, 일정 간격으로 묶어서 전송
  // (Firebase 무료 한도 소모와 안경 화면 깜빡임을 방지)
  fbPendingText = text;
  if (fbPendingTimer) return;
  fbPendingTimer = setTimeout(() => {
    fbPendingTimer = null;
    if (fbPendingText !== null) {
      writeCaption(fbPendingText, false);
      fbPendingText = null;
    }
  }, FB_MIN_INTERVAL_MS);
}

function writeCaption(text, isFinal) {
  fbDb
    .ref(`sessions/${fbSession}/caption`)
    .set({ text: text, final: !!isFinal, ts: Date.now() })
    .catch((e) => console.log("Firebase 전송 오류:", e));
}

const fbConfigInput = document.getElementById("fbConfig");
const sessionIdInput = document.getElementById("sessionId");
const saveFirebaseBtn = document.getElementById("saveFirebaseBtn");
const glassesUrlBox = document.getElementById("glassesUrlBox");
const glassesUrlOutput = document.getElementById("glassesUrlOutput");
const copyGlassesUrlBtn = document.getElementById("copyGlassesUrlBtn");

if (fbConfigInput) fbConfigInput.value = localStorage.getItem("fb_config") || "";
if (sessionIdInput)
  sessionIdInput.value = localStorage.getItem("session_id") || "myroom01";

if (saveFirebaseBtn) {
  saveFirebaseBtn.addEventListener("click", () => {
    const raw = fbConfigInput.value.trim();
    const session = (sessionIdInput.value.trim() || "myroom01").replace(
      /[^a-zA-Z0-9_-]/g,
      ""
    );
    const parsedConfig = parseFirebaseConfigInput(raw);
    if (!parsedConfig || typeof parsedConfig !== "object") {
      alert(
        "Firebase 설정을 해석하지 못했습니다. Firebase 콘솔의 firebaseConfig 코드 블록에서 중괄호 { }를 포함한 내용을 그대로 붙여넣어 주세요."
      );
      return;
    }
    if (!parsedConfig.databaseURL) {
      alert(
        "databaseURL 항목이 없습니다. Realtime Database를 아직 만들지 않았다면 Firebase 콘솔 → Build → Realtime Database에서 먼저 만든 후, 프로젝트 설정 화면을 새로고침해서 코드를 다시 복사해주세요."
      );
      return;
    }
    const normalizedJson = JSON.stringify(parsedConfig);
    localStorage.setItem("fb_config", normalizedJson);
    localStorage.setItem("session_id", session);
    initFirebaseIfConfigured();

    const b64 = btoa(unescape(encodeURIComponent(normalizedJson)));
    const url = `${window.location.origin}${window.location.pathname.replace(
      "index.html",
      ""
    )}glasses.html?fb=${encodeURIComponent(b64)}&session=${encodeURIComponent(
      session
    )}`;
    glassesUrlOutput.value = url;
    glassesUrlBox.style.display = "block";
  });
}

if (copyGlassesUrlBtn) {
  copyGlassesUrlBtn.addEventListener("click", async () => {
    const url = glassesUrlOutput.value;
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch (e) {}
    }
    if (!ok) {
      // 구형/제한 환경 대비 예비 경로
      try {
        glassesUrlOutput.removeAttribute("readonly");
        glassesUrlOutput.select();
        glassesUrlOutput.setSelectionRange(0, url.length);
        ok = document.execCommand("copy");
        glassesUrlOutput.setAttribute("readonly", "");
      } catch (e) {}
    }
    copyGlassesUrlBtn.textContent = ok
      ? "복사됨!"
      : "복사 실패 — 길게 눌러 직접 복사하세요";
    setTimeout(() => (copyGlassesUrlBtn.textContent = "URL 복사"), 2000);
  });
}

initFirebaseIfConfigured();

// ---- URL 파라미터로 설정 자동 구성 (안경에서 직접 타이핑하지 않아도 되도록) ----
// 사용 예: https://cawhjj.github.io/translator/?key=AQ.xxxx&lang=한국어&model=models/gemini-live-2.5-flash-native-audio
(function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("key") || params.get("apikey");
  const lang = params.get("lang");
  const model = params.get("model");
  let changed = false;

  if (key) {
    localStorage.setItem("gemini_api_key", key.trim());
    changed = true;
  }
  if (lang) {
    localStorage.setItem("target_lang", lang);
    changed = true;
  }
  if (model) {
    localStorage.setItem("live_model", model);
    changed = true;
  }
  // URL에 키가 그대로 남아있지 않도록 주소창에서 파라미터 제거(히스토리 갱신, 재로드 없음)
  if (changed && window.history && window.history.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }
})();

const micSelect = document.getElementById("micSelect");

async function populateMicList() {
  if (!micSelect || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices)
    return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    const saved = localStorage.getItem("mic_device_id") || "";
    micSelect.innerHTML = '<option value="">기본값 (자동 선택)</option>';
    mics.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `마이크 ${i + 1}`;
      if (d.deviceId === saved) opt.selected = true;
      micSelect.appendChild(opt);
    });
  } catch (e) {
    console.log("마이크 목록 조회 실패:", e);
  }
}
// 라벨은 권한 허용 후에만 보이므로, 설정을 열 때마다 다시 채워봄
if (settingsBtn) settingsBtn.addEventListener("click", populateMicList);
populateMicList();

const audioModeSelect = document.getElementById("audioMode");

// ---- 기존 사용자 설정 마이그레이션 ----
// 예전에 범용 모델을 직접 선택해 저장해두신 경우, 저장값이 새 기본값을 덮어써서
// 통역 전용 모델이 적용되지 않는 문제가 있어 1회만 자동 전환
(function migrateToTranslateModel() {
  if (localStorage.getItem("migrated_to_translate_model") === "1") return;
  const saved = localStorage.getItem("live_model");
  const legacyModels = [
    "models/gemini-live-2.5-flash-native-audio",
    "models/gemini-3.1-flash-live-preview",
  ];
  if (saved && legacyModels.includes(saved)) {
    localStorage.setItem("live_model", "models/gemini-3.5-live-translate-preview");
  }
  localStorage.setItem("migrated_to_translate_model", "1");
})();

// ---- Settings persistence ----
function loadSettings() {
  apiKeyInput.value = localStorage.getItem("gemini_api_key") || "";
  targetLangSelect.value = localStorage.getItem("target_lang") || "한국어";
  modelSelect.value =
    localStorage.getItem("live_model") ||
    "models/gemini-3.5-live-translate-preview";
  if (audioModeSelect)
    audioModeSelect.value = localStorage.getItem("audio_mode") || "conversation";
}
function saveSettings() {
  localStorage.setItem("gemini_api_key", apiKeyInput.value.trim());
  localStorage.setItem("target_lang", targetLangSelect.value);
  localStorage.setItem("live_model", modelSelect.value);
  if (audioModeSelect)
    localStorage.setItem("audio_mode", audioModeSelect.value);
  // 마이크 목록이 아직 안 채워진 상태(권한 전 등)에서 저장하면
  // 기존에 고른 마이크가 지워지므로, 목록이 실제로 있을 때만 반영
  if (micSelect && micSelect.options.length > 1) {
    localStorage.setItem("mic_device_id", micSelect.value);
  }
}
loadSettings();

settingsBtn.addEventListener("click", () => {
  settingsOverlay.classList.add("open");
});
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove("open");
});
saveSettingsBtn.addEventListener("click", () => {
  saveSettings();
  settingsOverlay.classList.remove("open");
  if (isRecording) {
    setStatus(
      "live",
      "설정 저장됨 · 적용하려면 마이크를 껐다 다시 켜주세요"
    );
  } else {
    setStatus("idle", "설정 저장됨 · 마이크를 눌러 시작하세요");
  }
});

// 최초 실행 시 키가 없으면 설정창 자동으로 열기
if (!localStorage.getItem("gemini_api_key")) {
  setTimeout(() => settingsOverlay.classList.add("open"), 300);
}

// ---- Status UI ----
function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
}

// ---- Caption UI ----
function clearEmptyState() {
  if (emptyState) emptyState.remove();
}
function startNewCaptionBubble() {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "caption-card live-partial";
  const src = document.createElement("div");
  src.className = "src";
  src.textContent = "통역 중…";
  const txt = document.createElement("div");
  txt.className = "txt";
  card.appendChild(src);
  card.appendChild(txt);
  captionArea.appendChild(card);
  captionArea.scrollTop = captionArea.scrollHeight;
  currentCaptionEl = txt;

  // 자막이 너무 많이 쌓이면 화면이 무거워지므로, 오래된 카드는 정리
  // (긴 강연/키노트에서 갈수록 느려지는 것을 방지)
  const MAX_CARDS = 30;
  const cards = captionArea.querySelectorAll(".caption-card");
  if (cards.length > MAX_CARDS) {
    for (let i = 0; i < cards.length - MAX_CARDS; i++) {
      cards[i].remove();
    }
  }
  return card;
}
let captionIdleTimer = null;

function appendPartialText(text) {
  if (!currentCaptionEl) startNewCaptionBubble();
  currentCaptionEl.textContent += text;
  captionArea.scrollTop = captionArea.scrollHeight;
  pushCaptionToGlasses(currentCaptionEl.textContent, false);

  // 일정 시간 새 텍스트가 없으면 자동으로 확정 처리
  // (연속 스트리밍 모델은 turnComplete를 안 보낼 수 있어 안전장치로 둠)
  if (captionIdleTimer) clearTimeout(captionIdleTimer);
  captionIdleTimer = setTimeout(() => {
    finalizeCaption();
  }, 2000);
}
function finalizeCaption() {
  if (captionIdleTimer) {
    clearTimeout(captionIdleTimer);
    captionIdleTimer = null;
  }
  if (!currentCaptionEl) return;
  const finalText = currentCaptionEl.textContent;
  const card = currentCaptionEl.closest(".caption-card");
  if (card) {
    card.classList.remove("live-partial");
    card.querySelector(".src").textContent = new Date().toLocaleTimeString(
      "ko-KR",
      { hour: "2-digit", minute: "2-digit" }
    );
  }
  currentCaptionEl = null;
  pushCaptionToGlasses(finalText, true);
}

// ---- PCM16 downsampling ----
// AudioContext의 원본 샘플레이트(보통 44100/48000) → 16000Hz Int16 PCM으로 변환
function floatTo16kPCM(float32Array, inputSampleRate) {
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;
  const outLength = Math.floor(float32Array.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const idxFloor = Math.floor(srcIdx);
    const idxCeil = Math.min(idxFloor + 1, float32Array.length - 1);
    const frac = srcIdx - idxFloor;
    // 선형 보간
    const sample =
      float32Array[idxFloor] * (1 - frac) + float32Array[idxCeil] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}
function int16ToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize)
    );
  }
  return btoa(binary);
}

// ---- Gemini Live WebSocket ----
function closeCodeToMessage(code, reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("api key") || r.includes("api_key") || code === 1008) {
    return "API 키가 유효하지 않습니다. 설정에서 키를 다시 확인해주세요";
  }
  if (r.includes("quota") || r.includes("resource_exhausted")) {
    return "사용 한도(quota) 초과입니다. 잠시 후 다시 시도해주세요";
  }
  if (r.includes("permission") || code === 1003) {
    return "이 API 키로는 해당 모델을 사용할 수 없습니다. 모델을 바꿔보세요";
  }
  if (code === 1006) {
    return "연결이 비정상 종료되었습니다. 네트워크 상태를 확인해주세요";
  }
  if (code === 1007) {
    return `설정이 거부되었습니다 (${reason || "형식 오류"})`;
  }
  return `연결 실패 (코드 ${code}${reason ? ": " + reason : ""})`;
}

// ---- 통역 전용 모델(gemini-3.5-live-translate-preview)이 요구하는 BCP-47 언어 코드 매핑 ----
const LANG_TO_BCP47 = {
  한국어: "ko",
  "영어(English)": "en",
  "일본어(日本語)": "ja",
  "중국어(中文)": "zh",
};
function toBCP47(targetLang) {
  return LANG_TO_BCP47[targetLang] || "ko";
}

function buildSystemPrompt(targetLang) {
  return (
    `You are a professional real-time simultaneous interpreter. ` +
    `You will receive a live audio stream in any spoken language, which may be continuous ` +
    `with few pauses (e.g. radio, news, lectures). ` +
    `Continuously transcribe and translate what you hear into ${targetLang} ` +
    `AS SOON AS each short phrase or clause is complete — do not wait for a full sentence ` +
    `or a long pause before responding. Prioritize low latency over perfect phrasing. ` +
    `Output ONLY the translated text — ` +
    `no original-language text, no explanations, no notes, no speaker labels. ` +
    `Keep translations short and natural, emitted phrase by phrase as speech happens. ` +
    `If there is silence or the audio is unclear, output nothing.`
  );
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const apiKey = localStorage.getItem("gemini_api_key");
    const model =
      localStorage.getItem("live_model") ||
      "models/gemini-3.5-live-translate-preview";
    const targetLang = localStorage.getItem("target_lang") || "한국어";

    if (!apiKey) {
      reject(new Error("API 키가 설정되지 않았습니다."));
      return;
    }

    setStatus("connecting", "연결 중…");
    const socket = new WebSocket(`${GEMINI_WS_BASE}?key=${apiKey}`);
    setupAcked = false;
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        setStatus(
          "error",
          "서버 응답이 없습니다(시간 초과). API 키의 모델 접근 권한 또는 네트워크를 확인해주세요"
        );
        try {
          socket.close();
        } catch (e) {}
        reject(new Error("Connection timeout waiting for setupComplete"));
      }
    }, 10000);

    socket.onopen = () => {
      const isDedicatedTranslateModel = model === "models/gemini-3.5-live-translate-preview";

      let setupMsg;
      if (isDedicatedTranslateModel) {
        // 통역 전용 모델: 턴 단위로 기다리지 않고 말하는 동안 계속 번역하는
        // 전용 파이프라인이라 시스템 프롬프트/VAD 튜닝이 필요 없음(지원도 안 됨).
        const s = {
          model: model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: toBCP47(targetLang),
              echoTargetLanguage: false,
            },
          },
          outputAudioTranscription: {},
        };
        // 프리뷰 API라 일부 선택 항목이 거부될 수 있어, 재시도 시에는 제외
        if (!useMinimalSetup) {
          s.inputAudioTranscription = {};
          s.contextWindowCompression = { slidingWindow: {} };
          s.sessionResumption = sessionResumeHandle
            ? { handle: sessionResumeHandle }
            : {};
        }
        setupMsg = { setup: s };
      } else {
        setupMsg = {
          setup: {
            model: model,
            generationConfig: { responseModalities: ["AUDIO"] },
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
            sessionResumption: sessionResumeHandle
              ? { handle: sessionResumeHandle }
              : {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                prefixPaddingMs: 100,
                silenceDurationMs: 500,
              },
            },
            systemInstruction: {
              parts: [{ text: buildSystemPrompt(targetLang) }],
            },
          },
        };
      }
      socket.send(JSON.stringify(setupMsg));
    };

    socket.onmessage = async (event) => {
      let raw;
      if (event.data instanceof Blob) {
        raw = await event.data.text();
      } else {
        raw = event.data;
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }

      if (msg.setupComplete && !setupAcked) {
        setupAcked = true;
        socket._markSettled();
        // 어떤 모델로 실제 연결됐는지 화면에 표시(설정이 반영됐는지 바로 확인 가능)
        const shortName = model.replace("models/", "").replace("-preview", "");
        setStatus("live", `실시간 통역 중 · ${shortName}`);
        resolve(socket);
        return;
      }

      if (msg.serverContent) {
        const sc = msg.serverContent;
        // 오디오 응답의 텍스트 대본(transcription)을 자막으로 사용
        if (sc.outputTranscription && sc.outputTranscription.text) {
          appendPartialText(sc.outputTranscription.text);
        }
        // 일부 모델/구성은 텍스트 파트를 함께 보낼 수 있어 예비로 처리 (오디오 파트는 무시)
        if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
          for (const part of sc.modelTurn.parts) {
            if (part.text) appendPartialText(part.text);
          }
        }
        if (sc.turnComplete) finalizeCaption();
        if (sc.interrupted) finalizeCaption();
      }

      if (msg.sessionResumptionUpdate) {
        const sru = msg.sessionResumptionUpdate;
        if (sru.resumable && sru.newHandle) {
          sessionResumeHandle = sru.newHandle;
        }
      }

      if (msg.goAway) {
        // 세션이 곧 종료됨을 서버가 알림 → 조용히 재연결 준비
        console.log("Gemini goAway signal received");
      }

      if (
        !msg.setupComplete &&
        !msg.serverContent &&
        !msg.goAway &&
        !msg.sessionResumptionUpdate &&
        !msg.usageMetadata
      ) {
        // 예상치 못한 응답(예: 에러 페이로드) — 디버깅을 위해 콘솔에 기록
        console.log("Gemini Live: unrecognized message", msg);
      }
    };

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        setStatus("error", "연결 오류 — API 키/네트워크를 확인하세요");
        reject(new Error("WebSocket error"));
      }
    };

    socket.onclose = (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        // 설정 항목이 거부된 경우(1007), 선택 항목을 빼고 자동으로 한 번 재시도
        if (event.code === 1007 && !useMinimalSetup) {
          useMinimalSetup = true;
          console.log("설정 거부됨 — 최소 설정으로 재시도합니다:", event.reason);
          connectWebSocket().then(resolve).catch(reject);
          return;
        }
        const reason = closeCodeToMessage(event.code, event.reason);
        setStatus("error", reason);
        reject(new Error(reason));
        return;
      }
      if (isRecording) {
        attemptReconnect();
      }
    };

    // resolve()가 호출되는 setupComplete 분기에서도 settled = true로 표시되도록
    // onmessage 쪽에서 settled 변수를 참조할 수 있게 socket 객체에 매달아 둠
    socket._markSettled = () => {
      settled = true;
      clearTimeout(timeoutId);
    };
  });
}

let reconnectAttempts = 0;

async function attemptReconnect() {
  if (reconnectingInProgress || !isRecording) return;
  reconnectingInProgress = true;
  setupAcked = false;
  reconnectAttempts++;

  // 연속 실패 시 점점 간격을 늘려 재시도(최대 5초) — 서버를 두드리지 않도록
  const backoffMs = Math.min(500 * reconnectAttempts, 5000);
  setStatus("connecting", "세션 갱신 중 (자동 재연결)…");
  await new Promise((r) => setTimeout(r, backoffMs));

  if (!isRecording) {
    reconnectingInProgress = false;
    return;
  }

  try {
    const newSocket = await connectWebSocket();
    ws = newSocket;
    reconnectAttempts = 0;
    setStatus("live", "실시간 통역 중 (재연결됨)");
  } catch (e) {
    if (reconnectAttempts >= 5) {
      setStatus(
        "error",
        "재연결에 반복 실패했습니다. 마이크를 다시 눌러 재시작해주세요"
      );
      reconnectAttempts = 0;
      stopRecording(false);
    } else {
      reconnectingInProgress = false;
      attemptReconnect();
      return;
    }
  } finally {
    reconnectingInProgress = false;
  }
}

// ---- 화면 꺼짐 방지 (긴 강연 중 화면이 잠기면 오디오/연결이 끊기므로) ----
let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (e) {
    console.log("화면 꺼짐 방지 사용 불가:", e);
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {}
    wakeLock = null;
  }
}

// 다른 앱에 갔다가 돌아오면 화면 잠금 방지가 해제되므로 다시 요청하고,
// iOS에서 백그라운드 진입 시 정지되는 오디오 컨텍스트도 다시 살림
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !isRecording) return;
  if (!wakeLock) requestWakeLock();
  if (audioCtx && audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch (e) {}
  }
  if (ws && ws.readyState !== WebSocket.OPEN) {
    attemptReconnect();
  }
});

// ---- Mic capture ----
async function startRecording() {
  const selectedMicId = localStorage.getItem("mic_device_id") || "";
  const audioMode = localStorage.getItem("audio_mode") || "conversation";
  // 강연·미디어 모드: 통화용 오디오 처리를 모두 끔.
  // (에코 제거/잡음 억제는 "가까운 한 사람의 목소리"에 최적화되어 있어,
  //  스피커에서 나오는 소리나 멀리서 들리는 강연 음성을 잡음으로 지워버림)
  const isLectureMode = audioMode === "lecture";
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
        channelCount: 1,
        echoCancellation: !isLectureMode,
        noiseSuppression: !isLectureMode,
        autoGainControl: !isLectureMode,
      },
    });
  } catch (err) {
    setStatus("error", "마이크 권한이 필요합니다");
    return;
  }

  const track = mediaStream.getAudioTracks()[0];
  if (track) console.log("사용 중인 마이크:", track.label);

  try {
    ws = await connectWebSocket();
  } catch (err) {
    setStatus("error", err.message || "연결 실패");
    mediaStream.getTracks().forEach((t) => t.stop());
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContextClass();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  const BUFFER_SIZE = 4096;
  processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);

  processorNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !setupAcked) return;
    // 네트워크가 순간적으로 느려져 전송 버퍼가 쌓이면, 계속 밀어넣지 않고
    // 이번 조각은 건너뜀. 그래야 지연이 계속 누적되지 않고 실시간에 가깝게 유지됨
    // (긴 강연에서 갈수록 점점 느려지는 현상 방지)
    const BUFFERED_LIMIT = 262144; // 256KB
    if (ws.bufferedAmount > BUFFERED_LIMIT) return;

    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16kPCM(input, audioCtx.sampleRate);
    const b64 = int16ToBase64(pcm16);
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: b64,
            mimeType: "audio/pcm;rate=16000",
          },
        },
      })
    );
  };

  // 스피커(실제 하드웨어 출력)로는 전혀 연결하지 않고, 가상의(더미) 오디오 목적지에만
  // 연결해서 프로세서가 동작하도록 함. 실제 destination에 연결하면 iOS Safari가
  // "통화 모드"로 전환되어 소리가 리시버(귀 스피커)로만 나오는 문제가 생기기 때문.
  const dummyDest = audioCtx.createMediaStreamDestination();
  sourceNode.connect(processorNode);
  processorNode.connect(dummyDest);

  isRecording = true;
  reconnectAttempts = 0;
  micBtn.classList.add("recording");
  micBtn.textContent = "⏹️";
  requestWakeLock();
}

function stopRecording(closeSocket = true) {
  isRecording = false;
  micBtn.classList.remove("recording");
  micBtn.textContent = "🎤";
  finalizeCaption();
  releaseWakeLock();

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (closeSocket && ws) {
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
  if (!ws) setStatus("idle", "대기 중");
}

// ---- Mic button ----
micBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording(true);
  } else {
    startRecording();
  }
});

// ---- Service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

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
let audioCtx = null;
let sourceNode = null;
let processorNode = null;
let mediaStream = null;
let isRecording = false;
let currentCaptionEl = null;
let setupAcked = false;

// ---- Settings persistence ----
function loadSettings() {
  apiKeyInput.value = localStorage.getItem("gemini_api_key") || "";
  targetLangSelect.value = localStorage.getItem("target_lang") || "한국어";
  modelSelect.value =
    localStorage.getItem("live_model") ||
    "models/gemini-live-2.5-flash-native-audio";
}
function saveSettings() {
  localStorage.setItem("gemini_api_key", apiKeyInput.value.trim());
  localStorage.setItem("target_lang", targetLangSelect.value);
  localStorage.setItem("live_model", modelSelect.value);
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
  setStatus("idle", "설정 저장됨 · 마이크를 눌러 시작하세요");
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
  return card;
}
function appendPartialText(text) {
  if (!currentCaptionEl) startNewCaptionBubble();
  currentCaptionEl.textContent += text;
  captionArea.scrollTop = captionArea.scrollHeight;
}
function finalizeCaption() {
  if (!currentCaptionEl) return;
  const card = currentCaptionEl.closest(".caption-card");
  if (card) {
    card.classList.remove("live-partial");
    card.querySelector(".src").textContent = new Date().toLocaleTimeString(
      "ko-KR",
      { hour: "2-digit", minute: "2-digit" }
    );
  }
  currentCaptionEl = null;
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
function buildSystemPrompt(targetLang) {
  return (
    `You are a professional real-time simultaneous interpreter. ` +
    `You will receive a live audio stream in any spoken language. ` +
    `Continuously transcribe and translate what you hear into ${targetLang}, ` +
    `and output ONLY the translated text as it becomes available — ` +
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
      "models/gemini-live-2.5-flash-native-audio";
    const targetLang = localStorage.getItem("target_lang") || "한국어";

    if (!apiKey) {
      reject(new Error("API 키가 설정되지 않았습니다."));
      return;
    }

    setStatus("connecting", "연결 중…");
    const socket = new WebSocket(`${GEMINI_WS_BASE}?key=${apiKey}`);
    setupAcked = false;

    socket.onopen = () => {
      const setupMsg = {
        setup: {
          model: model,
          generationConfig: { responseModalities: ["TEXT"] },
          systemInstruction: {
            parts: [{ text: buildSystemPrompt(targetLang) }],
          },
        },
      };
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
        setStatus("live", "실시간 통역 중");
        resolve(socket);
        return;
      }

      if (msg.serverContent) {
        const sc = msg.serverContent;
        if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
          for (const part of sc.modelTurn.parts) {
            if (part.text) appendPartialText(part.text);
          }
        }
        if (sc.turnComplete) finalizeCaption();
        if (sc.interrupted) finalizeCaption();
      }

      if (msg.goAway) {
        // 세션이 곧 종료됨을 서버가 알림 → 조용히 재연결 준비
        console.log("Gemini goAway signal received");
      }
    };

    socket.onerror = () => {
      setStatus("error", "연결 오류 — API 키/네트워크를 확인하세요");
      reject(new Error("WebSocket error"));
    };

    socket.onclose = () => {
      if (isRecording) {
        setStatus("error", "연결이 끊어졌습니다. 마이크를 다시 눌러주세요");
        stopRecording(false);
      }
    };
  });
}

// ---- Mic capture ----
async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    setStatus("error", "마이크 권한이 필요합니다");
    return;
  }

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

  // 스피커로 마이크 소리가 재생되지 않도록 gain 0인 노드를 거쳐 destination에 연결
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  sourceNode.connect(processorNode);
  processorNode.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  isRecording = true;
  micBtn.classList.add("recording");
  micBtn.textContent = "⏹️";
}

function stopRecording(closeSocket = true) {
  isRecording = false;
  micBtn.classList.remove("recording");
  micBtn.textContent = "🎤";
  finalizeCaption();

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

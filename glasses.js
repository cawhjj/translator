const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const feed = document.getElementById("feed");
const emptyMsg = document.getElementById("emptyMsg");

function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
}

const MAX_LINES = 6; // 화면에 유지할 최대 줄 수 (넘치면 위로 흘려보냄)
let currentLineEl = null;
let lastFinalTs = 0;

function clearEmpty() {
  if (emptyMsg) emptyMsg.remove();
}

function speakerClass(speaker) {
  if (speaker === undefined || speaker === null) return "";
  const n = Math.abs(parseInt(speaker, 10) || 0) % 4;
  return "spk" + n;
}

function pruneLines() {
  const lines = feed.querySelectorAll(".line");
  if (lines.length > MAX_LINES) {
    for (let i = 0; i < lines.length - MAX_LINES; i++) lines[i].remove();
  }
}

function startNewLine(speaker) {
  clearEmpty();
  // 이전 줄을 흐리게(과거) 처리
  if (currentLineEl) currentLineEl.classList.remove("current");
  const el = document.createElement("div");
  el.className = "line current";
  const sc = speakerClass(speaker);
  if (sc) el.classList.add(sc);
  feed.appendChild(el);
  currentLineEl = el;
  pruneLines();
  return el;
}

function render(data) {
  const text = data.text || "";
  const isFinal = !!data.final;
  const speaker = data.speaker;

  // 새 발화 시작 조건: 아직 줄이 없거나, 직전 줄이 이미 확정(final)됐던 경우
  if (!currentLineEl || currentLineEl.dataset.final === "1") {
    startNewLine(speaker);
  } else if (speaker !== undefined && currentLineEl.dataset.speaker !== String(speaker)) {
    // 화자가 바뀌면 새 줄로 분리
    startNewLine(speaker);
  }

  if (speaker !== undefined) currentLineEl.dataset.speaker = String(speaker);
  currentLineEl.textContent = text;
  currentLineEl.classList.toggle("partial", !isFinal);
  if (isFinal) {
    currentLineEl.dataset.final = "1";
    lastFinalTs = Date.now();
  }
}

const params = new URLSearchParams(window.location.search);
const fbParam = params.get("fb");
const session = params.get("session") || "myroom01";

if (!fbParam) {
  setStatus("error", "설정 URL이 아닙니다 (fb 파라미터 없음)");
} else {
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(fbParam))));
    const config = JSON.parse(json);
    firebase.initializeApp(config);
    const db = firebase.database();

    setStatus("connecting", "연결 중…");

    const ref = db.ref(`sessions/${session}/caption`);
    ref.on(
      "value",
      (snapshot) => {
        setStatus("live", `실시간 수신 중 (세션: ${session})`);
        const data = snapshot.val();
        if (!data || !data.text) return;
        render(data);
      },
      (error) => {
        setStatus("error", "수신 오류: " + error.message);
      }
    );
  } catch (e) {
    setStatus("error", "설정 해석 오류: " + e.message);
  }
}

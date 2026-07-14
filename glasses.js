const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const captionText = document.getElementById("captionText");

function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
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
        captionText.textContent = data.text;
        captionText.classList.remove("empty");
        captionText.classList.toggle("partial", !data.final);
      },
      (error) => {
        setStatus("error", "수신 오류: " + error.message);
      }
    );
  } catch (e) {
    setStatus("error", "설정 해석 오류: " + e.message);
  }
}

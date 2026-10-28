// 日語語音：瀏覽器內建 speechSynthesis。
//
// Android 上 getVoices() 在頁面剛載入時常回傳空陣列，所以：
// 先試一次 → 等 voiceschanged → 3 秒內仍無事件就再呼叫一次 getVoices() 才下結論。
// 判定沒有日語語音之後仍持續監聽，語音清單晚到時會自動恢復。

const WAIT_MS = 3000;

let status = 'unknown'; // unknown | ok | none | unsupported
let voice = null;
let readyPromise = null;
const listeners = new Set();

const supported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return false;
  const ja = voices.filter((v) => /^ja([-_]|$)/i.test(v.lang));
  voice = ja.find((v) => /japanese|日本語/i.test(v.name)) || ja[0] || null;
  return true;
}

function setStatus(next) {
  if (next === status) return;
  status = next;
  listeners.forEach((fn) => fn(status));
}

export function getStatus() {
  return status;
}

export function voiceName() {
  return voice ? voice.name : '';
}

export function onStatusChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    if (!supported()) {
      setStatus('unsupported');
      resolve(status);
      return;
    }

    let settled = false;
    let timer;
    const conclude = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };

    speechSynthesis.addEventListener('voiceschanged', () => {
      if (!pickVoice()) return;
      setStatus(voice ? 'ok' : 'none');
      // 有些裝置清單分批載入：先沒有日語，之後的事件才補上。找到日語才提前結束等待
      if (voice) conclude();
    });

    if (pickVoice() && voice) {
      setStatus('ok');
      conclude();
      return;
    }

    timer = setTimeout(() => {
      pickVoice();
      setStatus(voice ? 'ok' : 'none');
      conclude();
    }, WAIT_MS);
  });
  return readyPromise;
}

// iOS 需要在使用者點擊的當下先發聲一次，之後程式觸發的語音才會出聲
export function unlock() {
  if (!supported()) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'ja-JP';
    speechSynthesis.speak(u);
  } catch {
    // 忽略
  }
}

// 念出文字；念完（或出錯、逾時）時 resolve
export function speak(text, { rate = 0.8 } = {}) {
  return new Promise((resolve) => {
    if (!supported() || status === 'unsupported') {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // 部分 Chrome 版本偶爾不觸發 onend，用逾時保底
    const timer = setTimeout(() => finish(true), 1500 + [...text].length * 600 / rate);

    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      if (voice) u.voice = voice;
      u.rate = rate;
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      speechSynthesis.speak(u);
    } catch {
      finish(false);
    }
  });
}

export function stop() {
  if (supported()) speechSynthesis.cancel();
}

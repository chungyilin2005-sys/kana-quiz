// localStorage 讀寫。所有 key 統一前綴 kanaQuiz:，讀寫都包在 try/catch 裡；
// 無法使用 localStorage 時（私密模式、被封鎖）退回記憶體，至少本次開啟仍能練習。

const PREFIX = 'kanaQuiz:';
const STATE_KEY = 'state';
const memory = {};

export const DEFAULT_SETTINGS = {
  newPerDay: 5,
  roundSize: 30,
  syncScripts: false,
  ttsRate: 0.8,
  writeMode: 'paper',   // 書寫題：paper 紙筆、screen 螢幕手寫
};

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return key in memory ? memory[key] : fallback;
    return JSON.parse(raw);
  } catch {
    return key in memory ? memory[key] : fallback;
  }
}

export function save(key, value) {
  memory[key] = value;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function freshState(firstUnits) {
  return {
    version: 1,
    items: {},            // id -> { read, write, wrongWith }
    unlocked: [...firstUnits],
    log: {},              // 'YYYY-MM-DD' -> { q, correct, ms, newItems, rounds }
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function loadState(firstUnits) {
  const s = load(STATE_KEY, null);
  if (!s || typeof s !== 'object' || !Array.isArray(s.unlocked)) return freshState(firstUnits);
  s.items ||= {};
  s.log ||= {};
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  if (s.unlocked.length === 0) s.unlocked = [...firstUnits];
  return s;
}

export function saveState(state) {
  return save(STATE_KEY, state);
}

export function clearAll() {
  for (const k of Object.keys(memory)) delete memory[k];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // 無法存取時只清記憶體
  }
}

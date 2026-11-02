// 激勵制度：每日目標、連續天數與休息卡、稱號。純函式，不碰 DOM 與 localStorage。

import { addDays, readLevel, hasReading, UNLOCK_LEVEL } from './srs.js';

// 每連續達標 7 天得 1 張休息卡，最多存 2 張
export const CARD_EVERY = 7;
export const MAX_CARDS = 2;

// 這天有沒有達標。答題當下達標會記 met；舊資料沒有 met 就用目前的目標題數判斷
export function metGoal(entry, goal) {
  if (!entry) return false;
  return entry.met === true || (entry.q ?? 0) >= goal;
}

export function dailyProgress(state, day) {
  const goal = state.settings.dailyGoal;
  const done = state.log[day]?.q ?? 0;
  return { goal, done, met: metGoal(state.log[day], goal), left: Math.max(0, goal - done) };
}

// 從第一天練習一路模擬到今天，算出連續天數、最長紀錄、休息卡。
// 沒達標的日子：連續中有休息卡就自動用掉一張（連續天數不增加也不中斷），沒有卡就歸零。
// 今天還沒達標不算斷，今天達標才加一天。
export function streakInfo(state, day) {
  const goal = state.settings.dailyGoal;
  const met = (d) => metGoal(state.log[d], goal);
  const res = { current: 0, best: 0, cards: 0, todayMet: met(day), restDays: [], cardDays: [] };

  const first = Object.keys(state.log).filter((d) => (state.log[d]?.q ?? 0) > 0).sort()[0];
  if (!first || first > day) return res;

  let run = 0; // 這一段連續裡達標的天數，用來發休息卡
  for (let d = first; d <= day; d = addDays(d, 1)) {
    if (met(d)) {
      res.current += 1;
      run += 1;
      if (run % CARD_EVERY === 0 && res.cards < MAX_CARDS) {
        res.cards += 1;
        res.cardDays.push(d);
      }
    } else if (d === day) {
      break;
    } else if (res.current > 0 && res.cards > 0) {
      res.cards -= 1;
      res.restDays.push(d);
    } else {
      res.current = 0;
      run = 0;
    }
    res.best = Math.max(res.best, res.current);
  }
  return res;
}

// 截至昨天、連續用掉了幾張休息卡（首頁提示用）
export function restDaysEndingYesterday(info, day) {
  const set = new Set(info.restDays);
  let n = 0;
  for (let d = addDays(day, -1); set.has(d); d = addDays(d, -1)) n += 1;
  return n;
}

// ---------- 稱號 ----------

const isSeion = (script) => (it) => it.script === script && it.type === 'seion';
const isDakuon = (it) => it.type === 'dakuon' || it.type === 'handakuon';

// 依序取得；need 省略表示這一組要全部記住
export const TITLES = [
  { id: 'start', name: '入門' },
  { id: 'hira10', name: '平假名見習', desc: '平假名記住 10 個字', pool: (it) => it.script === 'hira', need: 10 },
  { id: 'hira', name: '平假名通', desc: '平假名清音 46 字全部記住', pool: isSeion('hira') },
  { id: 'kata10', name: '片假名見習', desc: '片假名記住 10 個字', pool: (it) => it.script === 'kata', need: 10 },
  { id: 'seion', name: '雙假名通', desc: '平假名、片假名清音全部記住', pool: (it) => it.type === 'seion' },
  { id: 'dakuon', name: '濁音達人', desc: '濁音、半濁音全部記住', pool: isDakuon },
  { id: 'master', name: '50 音大師', desc: '拗音也全部記住', pool: (it) => it.type === 'yoon' },
];

// 這個稱號還差幾個字（0 表示達成）
export function titleRemaining(title, items, state) {
  if (!title.pool) return 0;
  const pool = items.filter((it) => hasReading(it) && title.pool(it));
  const got = pool.filter((it) => readLevel(state, it.id) >= UNLOCK_LEVEL).length;
  return Math.max(0, (title.need ?? pool.length) - got);
}

// 依序檢查，把新達成的稱號記進 state.milestones（會修改 state），回傳新取得的稱號 id。
// 拿到的稱號不會因為字掉級而收回；要前一個稱號拿到了才會往下檢查。
export function awardTitles(items, state, day) {
  state.milestones ||= {};
  const got = [];
  for (const t of TITLES.slice(1)) {
    if (state.milestones[t.id]) continue;
    if (titleRemaining(t, items, state) > 0) break;
    state.milestones[t.id] = day;
    got.push(t.id);
  }
  return got;
}

// 目前稱號與下一個稱號（next 為 null 表示全部拿到了）
export function titleInfo(items, state) {
  const have = state.milestones || {};
  let i = 0;
  while (i + 1 < TITLES.length && have[TITLES[i + 1].id]) i += 1;
  const next = TITLES[i + 1] || null;
  return {
    title: TITLES[i],
    next,
    remaining: next ? titleRemaining(next, items, state) : 0,
  };
}

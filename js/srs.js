// 間隔重複（Leitner 五級）與解鎖邏輯。純函式，不碰 DOM 與 localStorage，方便測試。

// 一天的分界是凌晨 4:00，深夜練習仍算前一天
const DAY_START_HOUR = 4;

// 各等級答完後幾天再考；精熟後 30 天抽查
const INTERVAL_DAYS = { 1: 1, 2: 1, 3: 3, 4: 7, 5: 14 };
const MASTERED_DAYS = 30;
const MAX_LEVEL = 5;

// 「快」的門檻（毫秒）
export const FAST_MS = { choice: 2500, typing: 4000 };

// 解鎖下一單位所需的 read 等級
export const UNLOCK_LEVEL = 3;

// 促音、長音沒有單獨讀音：只看說明卡，不進認讀排程，也不擋解鎖
const NO_READING_TYPES = new Set(['sokuon', 'chouon']);

export function hasReading(item) {
  return !NO_READING_TYPES.has(item.type);
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function today(now = new Date()) {
  return ymd(new Date(now.getTime() - DAY_START_HOUR * 3600 * 1000));
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

export function isFast(ms, kind) {
  return ms != null && ms <= FAST_MS[kind];
}

// 依作答結果更新一條軌道（read 或 write），回傳新的軌道物件，不修改傳入值。
// fast：快且正確才升級；同一天同一軌道只升一次。
export function applyAnswer(track, { correct, fast, ms }, day) {
  const t = { level: 0, due: null, streak: 0, ...track };
  let leveledUp = false;

  if (!correct) {
    t.level = 1;
    t.streak = 0;
    t.mastered = false;
  } else {
    t.streak += 1;
    if (fast && t.upDay !== day) {
      if (t.level >= MAX_LEVEL) t.mastered = true;
      else t.level += 1;
      t.upDay = day;
      leveledUp = true;
    }
    // 新字即使答得慢，也要進入複習排程
    if (t.level === 0) t.level = 1;
  }

  t.due = addDays(day, t.mastered ? MASTERED_DAYS : INTERVAL_DAYS[t.level]);
  if (ms != null) t.lastMs = Math.round(ms);
  return { track: t, leveledUp };
}

export function readLevel(state, id) {
  return state.items[id]?.read?.level ?? 0;
}

export function isDue(track, day) {
  return !!track && track.level > 0 && !!track.due && track.due <= day;
}

// 單位分組：同步模式下，平假名與片假名的同一行（hira-X / kata-X）放在同一組一起解鎖
export function unitGroups(units, sync) {
  if (!sync) return units.map((u) => [u.unit]);
  const names = new Set(units.map((u) => u.unit));
  const groups = [];
  const used = new Set();
  for (const u of units) {
    if (used.has(u.unit)) continue;
    const group = [u.unit];
    used.add(u.unit);
    const m = u.unit.match(/^hira-(.+)$/);
    if (m && names.has(`kata-${m[1]}`)) {
      group.push(`kata-${m[1]}`);
      used.add(`kata-${m[1]}`);
    }
    groups.push(group);
  }
  return groups;
}

// 下一組要解鎖的單位（只計 enabled 的單位）；全部解鎖完回傳 null
export function nextUnitGroup(units, unlocked, { sync = false, enabled = () => true } = {}) {
  const have = new Set(unlocked);
  for (const group of unitGroups(units, sync)) {
    const pending = group.filter((name) => !have.has(name) && enabled(units.find((u) => u.unit === name)));
    if (pending.length) return pending;
  }
  return null;
}

export function unlockedItems(items, unlocked) {
  const set = new Set(unlocked);
  return items.filter((it) => set.has(it.unit));
}

// 所有已解鎖項目的 read 等級都 ≥ 3 才能解鎖下一單位
export function readyToUnlock(items, state) {
  const list = unlockedItems(items, state.unlocked).filter(hasReading);
  return list.length > 0 && list.every((it) => readLevel(state, it.id) >= UNLOCK_LEVEL);
}

// 有需要就解鎖下一組單位（會修改 state），回傳新解鎖的單位名稱陣列
export function autoUnlock(data, state, opts = {}) {
  if (!readyToUnlock(data.items, state)) return [];
  const group = nextUnitGroup(data.units, state.unlocked, { sync: state.settings.syncScripts, ...opts });
  if (!group) return [];
  state.unlocked.push(...group);
  return group;
}

export function manualUnlock(data, state, opts = {}) {
  const group = nextUnitGroup(data.units, state.unlocked, { sync: state.settings.syncScripts, ...opts });
  if (!group) return [];
  state.unlocked.push(...group);
  return group;
}

// 還沒解鎖下一單位前，有幾個已解鎖的字未達 3 級
export function itemsBelowUnlock(items, state) {
  return unlockedItems(items, state.unlocked)
    .filter((it) => hasReading(it) && readLevel(state, it.id) < UNLOCK_LEVEL).length;
}

export function dueReadItems(items, state, day) {
  return unlockedItems(items, state.unlocked)
    .filter((it) => isDue(state.items[it.id]?.read, day))
    .sort((a, b) => {
      const ta = state.items[a.id].read;
      const tb = state.items[b.id].read;
      return ta.due.localeCompare(tb.due) || ta.level - tb.level || a.order - b.order;
    });
}

export function newItemsAvailable(items, state) {
  return unlockedItems(items, state.unlocked)
    .filter((it) => readLevel(state, it.id) === 0 && !state.items[it.id]?.seen)
    .sort((a, b) => a.order - b.order);
}

export function newQuotaLeft(state, day) {
  const used = state.log[day]?.newItems ?? 0;
  return Math.max(0, state.settings.newPerDay - used);
}

// 連續練習天數：從今天（今天還沒練就從昨天）往回數
export function streakDays(state, day) {
  const practiced = (d) => (state.log[d]?.q ?? 0) > 0;
  let d = practiced(day) ? day : addDays(day, -1);
  let n = 0;
  while (practiced(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

// 出題、選項產生、判分、回合組成。純函式＋一個不碰 DOM 的 Session 類別。
//
// 題型代號沿用規格書：
//   A 看假名選拼音、B 看拼音選假名、C 聽音選假名、D 平片對照、E 打字（看假名輸入拼音）、F 書寫自評

import {
  dueReadItems, dueWriteItems, hasReading, newItemsAvailable, newQuotaLeft, readLevel, unlockedItems, writeLevel, writeOpen,
} from './srs.js';

// ぢ、づ（及片假名）與じ、ず同音：不出「看拼音選假名」與「聽音選假名」
const NO_ROMAJI_TO_KANA = new Set(['h-dji', 'h-dzu', 'k-dji', 'k-dzu']);
// を 的語音念成 o，和 お 聽起來一樣，不出聽音題
const NO_LISTENING = new Set([...NO_ROMAJI_TO_KANA, 'h-wo', 'k-wo']);

export const ALL_TYPES = ['A', 'B', 'C', 'D', 'E'];

const MAX_REVIEWS = 20;
const MAX_WRITES = 8;
// 書寫題先保留名額（最多佔回合的四分之一），避免認讀複習一多就永遠輪不到書寫
const WRITE_SHARE = 0.25;
export const WRITE_ROUND_SIZE = 10;
const MAX_REQUEUE_PER_ITEM = 3;

export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 打字比對：不分大小寫、去空白，全形英數轉半形
export function normalizeRomaji(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export function checkTyped(item, input) {
  const v = normalizeRomaji(input);
  return v !== '' && item.accept.some((a) => normalizeRomaji(a) === v);
}

function readingKeys(entry) {
  return new Set([entry.romaji, ...(entry.accept || [])].map(normalizeRomaji));
}

export function sameReading(a, b) {
  const kb = readingKeys(b);
  for (const k of readingKeys(a)) if (kb.has(k)) return true;
  return false;
}

// 這個字能不能出某種題型。D 需要對應的另一種假名已經學過（傳入 state 才判斷得了）
export function canAsk(item, type, state) {
  if (!hasReading(item)) return false;
  switch (type) {
    case 'A':
    case 'E':
      return true;
    case 'B':
      return !NO_ROMAJI_TO_KANA.has(item.id);
    case 'C':
      return !NO_LISTENING.has(item.id);
    case 'D':
      return !!item.pair && !!state && readLevel(state, item.pair) > 0;
    default:
      return false;
  }
}

// 等級 1～2 多出 A 與 C；等級 3 以上多出 B 與打字
const TYPE_WEIGHTS = {
  low: { A: 5, C: 3, B: 1, D: 1, E: 1 },
  high: { A: 1, C: 1, B: 3, D: 2, E: 3 },
};

export function pickType(item, level, rng = Math.random, enabled = ALL_TYPES, state = null) {
  const weights = level >= 3 ? TYPE_WEIGHTS.high : TYPE_WEIGHTS.low;
  const choices = enabled.filter((t) => weights[t] && canAsk(item, t, state));
  if (!choices.length) return null;
  const total = choices.reduce((s, t) => s + weights[t], 0);
  let r = rng() * total;
  for (const t of choices) {
    r -= weights[t];
    if (r < 0) return t;
  }
  return choices[choices.length - 1];
}

export function indexData(data) {
  const byId = new Map(data.items.map((it) => [it.id, it]));
  const byKana = new Map(data.items.map((it) => [it.kana, it]));
  return { byId, byKana };
}

// 題目要選出的那個字：D 是對應的另一種假名，其他題型是字本身
export function targetOf(item, type, index) {
  return type === 'D' ? index.byId.get(item.pair) : item;
}

// 濁音與半濁音視為同一類，補干擾項時一起用
const kindOf = (it) => (it.type === 'handakuon' ? 'dakuon' : it.type);

// 4 個選項。干擾項依序取：形近字 → 使用者最常誤選的字 → 同單位已解鎖字 → 同類已解鎖字 → 同類任一字。
// 選項不重複，也不放與正解同音的字。
export function buildChoices(item, type, { data, index, state, rng = Math.random }) {
  const target = targetOf(item, type, index);
  const field = type === 'A' ? 'romaji' : 'kana';
  const toEntry = (it) => ({ kana: it.kana, romaji: it.romaji, accept: it.accept, id: it.id });
  const fromConfusable = (c) => {
    const known = index.byKana.get(c.kana);
    return known ? toEntry(known) : { kana: c.kana, romaji: c.romaji, accept: [c.romaji] };
  };
  const sameKind = (it) => it.id !== target.id && it.script === target.script && kindOf(it) === kindOf(target);
  const unlocked = unlockedItems(data.items, state.unlocked);
  const wrongWith = Object.entries(state.items[target.id]?.wrongWith || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => index.byId.get(id))
    .filter((it) => it && it.script === target.script);

  const pools = [
    shuffle(target.confusables || [], rng).map(fromConfusable),
    wrongWith.map(toEntry),
    shuffle(unlocked.filter((it) => sameKind(it) && it.unit === target.unit), rng).map(toEntry),
    shuffle(unlocked.filter(sameKind), rng).map(toEntry),
    shuffle(data.items.filter(sameKind), rng).map(toEntry),
  ];

  const answer = toEntry(target);
  const used = new Set([answer[field]]);
  const distractors = [];
  for (const pool of pools) {
    for (const cand of pool) {
      if (distractors.length === 3) break;
      if (used.has(cand[field]) || sameReading(cand, target)) continue;
      used.add(cand[field]);
      distractors.push(cand);
    }
  }

  const options = shuffle([{ ...answer, correct: true }, ...distractors.map((d) => ({ ...d, correct: false }))], rng)
    .map((o) => ({ ...o, label: o[field] }));
  return { options, answerIndex: options.findIndex((o) => o.correct), target };
}

// 組成今日回合：到期 read 複習（最多 20）→ 新字（認識卡＋2 題簡單題）→ 到期 write 複習（最多 8）。
// 單字補題在階段四加入。
export function buildRound(data, state, day, { rng = Math.random, enabledTypes = ALL_TYPES } = {}) {
  const size = state.settings.roundSize;
  const writes = dueWriteItems(data.items, state, day).slice(0, Math.min(MAX_WRITES, Math.ceil(size * WRITE_SHARE)));
  const reviews = shuffle(dueReadItems(data.items, state, day).slice(0, Math.min(MAX_REVIEWS, size - writes.length)), rng);
  const steps = [];
  for (const it of reviews) {
    const type = pickType(it, readLevel(state, it.id), rng, enabledTypes, state);
    if (type) steps.push({ kind: 'q', id: it.id, type });
  }

  let budget = size - steps.length - writes.length;
  let quota = newQuotaLeft(state, day);
  const newIds = [];
  for (const it of newItemsAvailable(data.items, state)) {
    if (quota <= 0) break;
    // 促音、長音只有說明卡，不佔題數
    const cost = hasReading(it) ? 2 : 0;
    if (cost > budget) break;
    newIds.push(it.id);
    budget -= cost;
    quota -= 1;
  }
  steps.push(...newItemSteps(newIds.map((id) => data.items.find((it) => it.id === id)), enabledTypes));
  steps.push(...shuffle(writes, rng).map((it) => ({ kind: 'q', id: it.id, type: 'F' })));

  return { steps, newIds };
}

// 書寫頁的單獨練習：先寫到期的字；都寫完了就挑書寫等級低的字加練
export function buildWriteRound(data, state, day, { rng = Math.random } = {}) {
  let list = dueWriteItems(data.items, state, day);
  if (!list.length) {
    list = unlockedItems(data.items, state.unlocked)
      .filter((it) => writeOpen(it, state))
      .sort((a, b) => writeLevel(state, a.id) - writeLevel(state, b.id) || rng() - 0.5);
  }
  const steps = shuffle(list.slice(0, WRITE_ROUND_SIZE), rng).map((it) => ({ kind: 'q', id: it.id, type: 'F' }));
  return { steps, newIds: [] };
}

// 新字穿插：認識卡 n1、簡單題 n1、認識卡 n2、簡單題 n2、第二題 n1、認識卡 n3…，第二題隔幾題再考，效果比緊接著好
function newItemSteps(items, enabledTypes) {
  const steps = [];
  let pending = null;
  for (const it of items) {
    steps.push({ kind: 'intro', id: it.id });
    if (!hasReading(it)) continue;
    steps.push({ kind: 'q', id: it.id, type: 'A', isNew: true });
    if (pending) steps.push(secondEasy(pending, enabledTypes));
    pending = it;
  }
  if (pending) steps.push(secondEasy(pending, enabledTypes));
  return steps;
}

function secondEasy(item, enabledTypes) {
  // 有語音就聽音選字，否則看拼音選字；ぢ、づ兩者都不出，退回 A
  const type = ['C', 'B'].find((t) => enabledTypes.includes(t) && canAsk(item, t)) || 'A';
  return { kind: 'q', id: item.id, type, isNew: true };
}

// 今日任務做完後的加練：挑等級低、較早到期的已學字
export function buildExtraRound(data, state, { rng = Math.random, enabledTypes = ALL_TYPES } = {}) {
  const size = state.settings.roundSize;
  const learned = unlockedItems(data.items, state.unlocked)
    .filter((it) => readLevel(state, it.id) > 0 && hasReading(it))
    .sort((a, b) => {
      const ta = state.items[a.id].read;
      const tb = state.items[b.id].read;
      return ta.level - tb.level || (ta.due || '').localeCompare(tb.due || '') || rng() - 0.5;
    })
    .slice(0, size);
  const steps = shuffle(learned, rng)
    .map((it) => ({ kind: 'q', id: it.id, type: pickType(it, readLevel(state, it.id), rng, enabledTypes, state) }))
    .filter((s) => s.type);
  return { steps, newIds: [] };
}

// 一個回合的進行狀態。答錯時把同一題排進 3～5 題之後。
export class Session {
  constructor(steps, { rng = Math.random, extra = false } = {}) {
    this.steps = steps.map((s) => ({ ...s }));
    this.pos = 0;
    this.rng = rng;
    this.extra = extra;
    this.results = [];
    this.requeued = {};
    this.leveledUp = [];
    this.unlockedUnits = [];
  }

  get current() {
    return this.steps[this.pos] || null;
  }

  get done() {
    return this.pos >= this.steps.length;
  }

  get questionTotal() {
    return this.steps.filter((s) => s.kind === 'q').length;
  }

  // 目前是第幾題（從 1 起算；認識卡不算題）
  get questionNumber() {
    return this.steps.slice(0, this.pos + 1).filter((s) => s.kind === 'q').length;
  }

  advance() {
    this.pos += 1;
  }

  record(result) {
    this.results.push(result);
    if (!result.correct) this.requeue(this.current);
  }

  requeue(step) {
    const n = (this.requeued[step.id] || 0) + 1;
    if (n > MAX_REQUEUE_PER_ITEM) return;
    this.requeued[step.id] = n;

    const gap = 3 + Math.floor(this.rng() * 3); // 3～5 題後
    const copy = { kind: 'q', id: step.id, type: step.type, retry: true };

    // 找到第 gap-1 個之後的題目，插在它後面
    let seen = 0;
    for (let i = this.pos + 1; i < this.steps.length; i++) {
      if (this.steps[i].kind !== 'q') continue;
      seen += 1;
      if (seen === gap - 1) {
        this.steps.splice(i + 1, 0, copy);
        return;
      }
    }

    // 剩下的題目不夠：用本回合其他字的 A 題補到間隔夠，再重考
    const others = [...new Set(this.steps.filter((s) => s.kind === 'q' && s.id !== step.id).map((s) => s.id))];
    const fillers = shuffle(others, this.rng).slice(0, gap - 1 - seen);
    for (const id of fillers) this.steps.push({ kind: 'q', id, type: 'A', filler: true });
    this.steps.push(copy);
  }

  summary() {
    const graded = this.results;
    const correct = graded.filter((r) => r.correct).length;
    const times = graded.map((r) => r.ms).filter((ms) => ms != null);
    return {
      total: graded.length,
      correct,
      accuracy: graded.length ? correct / graded.length : 0,
      avgMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      leveledUp: [...new Set(this.leveledUp)],
      wrong: [...new Set(graded.filter((r) => !r.correct).map((r) => r.id))],
      unlockedUnits: this.unlockedUnits,
    };
  }
}

// 出題、選項產生、判分、回合組成。純函式＋一個不碰 DOM 的 Session 類別。
//
// 題型代號沿用規格書：
//   A 看假名選拼音、B 看拼音選假名、E 打字（看假名輸入拼音）
//   C 聽音選假名、D 平片對照（階段二）

import { dueReadItems, newItemsAvailable, newQuotaLeft, readLevel, unlockedItems } from './srs.js';

// ぢ、づ（及片假名）與じ、ず同音：不出「看拼音選假名」
const NO_ROMAJI_TO_KANA = new Set(['h-dji', 'h-dzu', 'k-dji', 'k-dzu']);
// 促音、長音沒有單獨讀音，不出拼音類題型
const NO_READING_TYPES = new Set(['sokuon', 'chouon']);

const MAX_REVIEWS = 20;
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

export function canAsk(item, type) {
  if (NO_READING_TYPES.has(item.type)) return false;
  if (type === 'B') return !NO_ROMAJI_TO_KANA.has(item.id);
  return type === 'A' || type === 'E';
}

// 等級 1～2 多出 A；等級 3 以上多出 B 與打字
const TYPE_WEIGHTS = {
  low: { A: 6, B: 2, E: 2 },
  high: { A: 2, B: 4, E: 4 },
};

export function pickType(item, level, rng = Math.random, enabled = ['A', 'B', 'E']) {
  const weights = level >= 3 ? TYPE_WEIGHTS.high : TYPE_WEIGHTS.low;
  const choices = enabled.filter((t) => weights[t] && canAsk(item, t));
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

// 4 個選項。干擾項依序取：形近字 → 使用者最常誤選的字 → 同單位已解鎖字 → 同類已解鎖字 → 同類任一字。
// 選項不重複，也不放與正解同音的字。
export function buildChoices(item, type, { data, index, state, rng = Math.random }) {
  const field = type === 'A' ? 'romaji' : 'kana';
  const toEntry = (it) => ({ kana: it.kana, romaji: it.romaji, accept: it.accept, id: it.id });
  const fromConfusable = (c) => {
    const known = index.byKana.get(c.kana);
    return known ? toEntry(known) : { kana: c.kana, romaji: c.romaji, accept: [c.romaji] };
  };
  const sameKind = (it) => it.id !== item.id && it.script === item.script && it.type === item.type;
  const unlocked = unlockedItems(data.items, state.unlocked);
  const wrongWith = Object.entries(state.items[item.id]?.wrongWith || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => index.byId.get(id))
    .filter(Boolean);

  const pools = [
    shuffle(item.confusables || [], rng).map(fromConfusable),
    wrongWith.map(toEntry),
    shuffle(unlocked.filter((it) => sameKind(it) && it.unit === item.unit), rng).map(toEntry),
    shuffle(unlocked.filter(sameKind), rng).map(toEntry),
    shuffle(data.items.filter(sameKind), rng).map(toEntry),
  ];

  const answer = toEntry(item);
  const used = new Set([answer[field]]);
  const distractors = [];
  for (const pool of pools) {
    for (const cand of pool) {
      if (distractors.length === 3) break;
      if (used.has(cand[field]) || sameReading(cand, item)) continue;
      used.add(cand[field]);
      distractors.push(cand);
    }
  }

  const options = shuffle([{ ...answer, correct: true }, ...distractors.map((d) => ({ ...d, correct: false }))], rng)
    .map((o) => ({ ...o, label: o[field] }));
  return { options, answerIndex: options.findIndex((o) => o.correct) };
}

// 組成今日回合：到期 read 複習（最多 20）→ 新字（認識卡＋2 題簡單題）。
// 書寫複習與單字補題在之後的階段加入。
export function buildRound(data, state, day, { rng = Math.random, enabledTypes } = {}) {
  const size = state.settings.roundSize;
  const reviews = shuffle(dueReadItems(data.items, state, day).slice(0, Math.min(MAX_REVIEWS, size)), rng);
  const steps = [];
  for (const it of reviews) {
    const type = pickType(it, readLevel(state, it.id), rng, enabledTypes);
    if (type) steps.push({ kind: 'q', id: it.id, type });
  }

  const budget = size - steps.length;
  const fresh = newItemsAvailable(data.items, state).filter((it) => canAsk(it, 'A'));
  const newCount = Math.min(newQuotaLeft(state, day), Math.floor(budget / 2), fresh.length);
  const newIds = fresh.slice(0, newCount).map((it) => it.id);
  steps.push(...newItemSteps(newIds));

  return { steps, newIds };
}

// 新字穿插：認識卡 n1、A n1、認識卡 n2、A n2、B n1、認識卡 n3…，第二題隔幾題再考，效果比緊接著好
function newItemSteps(ids) {
  const steps = [];
  ids.forEach((id, i) => {
    steps.push({ kind: 'intro', id });
    steps.push({ kind: 'q', id, type: 'A', isNew: true });
    if (i > 0) steps.push(secondEasy(ids[i - 1]));
  });
  if (ids.length) steps.push(secondEasy(ids[ids.length - 1]));
  return steps;
}

function secondEasy(id) {
  // ぢ、づ不出 B，退回 A
  return { kind: 'q', id, type: NO_ROMAJI_TO_KANA.has(id) ? 'A' : 'B', isNew: true };
}

// 今日任務做完後的加練：挑等級低、較早到期的已學字
export function buildExtraRound(data, state, { rng = Math.random, enabledTypes } = {}) {
  const size = state.settings.roundSize;
  const learned = unlockedItems(data.items, state.unlocked)
    .filter((it) => readLevel(state, it.id) > 0 && canAsk(it, 'A'))
    .sort((a, b) => {
      const ta = state.items[a.id].read;
      const tb = state.items[b.id].read;
      return ta.level - tb.level || (ta.due || '').localeCompare(tb.due || '') || rng() - 0.5;
    })
    .slice(0, size);
  const steps = shuffle(learned, rng)
    .map((it) => ({ kind: 'q', id: it.id, type: pickType(it, readLevel(state, it.id), rng, enabledTypes) }))
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

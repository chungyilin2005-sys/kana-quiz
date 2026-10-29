// 單字閱讀（題型 G）與混淆專練的純邏輯：斷字、轉拼音、長音 normalize、干擾項、組回合。
// 不碰 DOM 與 localStorage，測試直接 import。
//
// 單字題的步驟：{ kind: 'q', word: true, id: 單字, type }，type 為
//   W 選拼音、S 唸讀自評、T 打字（單字裡的假名都到 3 級才出）

import { hasReading, nextUnitGroup, readLevel, unlockedItems } from './srs.js';
import { canAsk, pickType, shuffle } from './quiz.js';

export const WORD_ROUND_SIZE = 10;
export const MIN_WORDS = 5;
export const DRILL_SIZE = 10;
const MAX_FOCUS = 10;
const TYPE_LEVEL = 3;

const VOWELS = 'aiueo';

// 長音 normalize：ā／â → aa，ou → oo，去掉空白、連字號、撇號，全形轉半形。
// 標準答案用雙母音（koohii），打字寫 kōhii、kouhii、koohii 都會變成同一個字串。
export function normalizeWordRomaji(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/([aiueo])[̄̂]/g, '$1$1')   // 長音符號（macron）、抑揚符（circumflex）
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s'’\-‐ー]/g, '')
    .replace(/ou/g, 'oo');
}

export function checkWordTyped(word, input) {
  const v = normalizeWordRomaji(input);
  return v !== '' && [word.romaji, ...(word.accept || [])].some((a) => normalizeWordRomaji(a) === v);
}

// 把單字切成假名：先比對兩個字的拗音，再比對單字
export function tokenize(text, index) {
  const chars = [...text];
  const tokens = [];
  for (let i = 0; i < chars.length;) {
    const two = chars.slice(i, i + 2).join('');
    const hit = (chars.length - i >= 2 && index.byKana.get(two)) || index.byKana.get(chars[i]);
    if (hit) {
      tokens.push({ kana: hit.kana, romaji: hit.romaji, type: hit.type, id: hit.id });
      i += [...hit.kana].length;
    } else {
      tokens.push({ kana: chars[i], romaji: '', type: 'unknown' });
      i += 1;
    }
  }
  return tokens;
}

// 假名序列轉拼音：促音重複下一個子音（ch 前寫 t），長音重複前一個母音
export function tokensToRomaji(tokens) {
  let out = '';
  tokens.forEach((t, i) => {
    if (t.type === 'sokuon') {
      const next = tokens[i + 1]?.romaji || '';
      if (next.startsWith('ch')) out += 't';
      else if (next && !VOWELS.includes(next[0])) out += next[0];
      return;
    }
    if (t.type === 'chouon') {
      const last = out[out.length - 1];
      if (last && VOWELS.includes(last)) out += last;
      return;
    }
    out += t.romaji;
  });
  return out;
}

const validRomaji = (r) => /^[a-z]+$/.test(r || '');

export function wordUnlocked(word, index, unlocked) {
  const set = new Set(unlocked);
  return word.requires.every((id) => set.has(index.byId.get(id)?.unit));
}

// 只出 requires 全部已解鎖的單字
export function availableWords(words, index, state) {
  return words.filter((w) => wordUnlocked(w, index, state.unlocked));
}

// 可讀單字不足 MIN_WORDS 個時，還要再解鎖幾組單位（行）；永遠湊不滿回傳 null
export function rowsUntilWords(data, words, index, state, min = MIN_WORDS) {
  const unlocked = [...state.unlocked];
  const count = () => words.filter((w) => wordUnlocked(w, index, unlocked)).length;
  let rows = 0;
  while (count() < min) {
    const group = nextUnitGroup(data.units, unlocked, { sync: state.settings.syncScripts });
    if (!group) return null;
    unlocked.push(...group);
    rows += 1;
  }
  return rows;
}

// 選拼音的 4 個選項。干擾項：把單字中 1 個假名換成它的形近字後轉拼音；
// 促音、長音另外產生「漏掉促音／長音」的寫法。不夠時才用同類的已解鎖字替換。
export function buildWordChoices(word, { data, index, state, rng = Math.random }) {
  const tokens = tokenize(word.word, index);
  const variants = [];
  const swap = (pos, repl) => {
    const toks = tokens.map((t, i) => (i === pos ? repl : t)).filter(Boolean);
    return { kana: toks.map((t) => t.kana).join(''), romaji: tokensToRomaji(toks) };
  };

  const primary = [];
  tokens.forEach((t, pos) => {
    const item = t.id && index.byId.get(t.id);
    if (!item) return;
    for (const c of item.confusables || []) {
      if (!validRomaji(c.romaji)) continue;
      const known = index.byKana.get(c.kana);
      primary.push(swap(pos, { kana: c.kana, romaji: c.romaji, type: known?.type || 'seion' }));
    }
    if (t.type === 'sokuon' || t.type === 'chouon') primary.push(swap(pos, null));
  });

  const unlocked = unlockedItems(data.items, state.unlocked);
  const fallback = [];
  tokens.forEach((t, pos) => {
    const item = t.id && index.byId.get(t.id);
    if (!item || !hasReading(item)) return;
    for (const other of unlocked) {
      if (other.id === item.id || other.script !== item.script || other.type !== item.type) continue;
      fallback.push(swap(pos, { kana: other.kana, romaji: other.romaji, type: other.type }));
    }
  });
  variants.push(...shuffle(primary, rng), ...shuffle(fallback, rng));

  const used = new Set([normalizeWordRomaji(word.romaji)]);
  const distractors = [];
  for (const v of variants) {
    if (distractors.length === 3) break;
    const key = normalizeWordRomaji(v.romaji);
    if (!v.romaji || used.has(key)) continue;
    used.add(key);
    distractors.push(v);
  }

  const options = shuffle([
    { kana: word.word, romaji: word.romaji, correct: true },
    ...distractors.map((d) => ({ ...d, correct: false })),
  ], rng).map((o) => ({ ...o, label: o.romaji }));
  return { options, answerIndex: options.findIndex((o) => o.correct) };
}

// 單字裡最弱（read 等級最低）的假名；促音、長音沒有認讀題，不列入
export function weakestKana(word, index, state) {
  return word.requires
    .map((id) => index.byId.get(id))
    .filter((it) => it && hasReading(it))
    .sort((a, b) => readLevel(state, a.id) - readLevel(state, b.id) || a.order - b.order)[0] || null;
}

// 答錯的單字：把其中最弱的假名排進下一回合（state.focus，會修改 state）
export function addFocus(state, word, index) {
  const weak = weakestKana(word, index, state);
  if (!weak) return null;
  state.focus = [weak.id, ...(state.focus || []).filter((id) => id !== weak.id)].slice(0, MAX_FOCUS);
  return weak.id;
}

// 單字題型：選拼音與唸讀自評輪替；單字裡的假名都到 3 級以上，也會出打字
export function wordTypes(word, index, state) {
  const types = ['W', 'S'];
  const weak = weakestKana(word, index, state);
  if (weak && readLevel(state, weak.id) >= TYPE_LEVEL) types.push('T');
  return types;
}

// 挑 n 個單字：沒讀過的優先，再來是最久沒讀的
export function pickWords(words, index, state, n, rng = Math.random) {
  const last = (w) => state.words?.[w.word]?.last || '';
  return shuffle(availableWords(words, index, state), rng)
    .sort((a, b) => last(a).localeCompare(last(b)))
    .slice(0, n);
}

export function wordSteps(list, index, state, rng = Math.random) {
  const offset = Math.floor(rng() * 2);
  return list.map((w, i) => {
    const types = wordTypes(w, index, state);
    const type = types.length > 2 && rng() < 1 / 3 ? 'T' : types[(i + offset) % 2];
    return { kind: 'q', word: true, id: w.word, type };
  });
}

export function buildWordRound(words, index, state, { rng = Math.random, size = WORD_ROUND_SIZE } = {}) {
  return { steps: wordSteps(pickWords(words, index, state, size, rng), index, state, rng), newIds: [] };
}

// 依 wrongWith 統計最常混淆的字組：[{ id: 正解, other: 誤選的字, count }]，次數多的在前
export function topConfusions(state, index, n = 10) {
  const pairs = [];
  for (const [id, prog] of Object.entries(state.items || {})) {
    if (!index.byId.has(id)) continue;
    for (const [other, count] of Object.entries(prog.wrongWith || {})) {
      if (index.byId.has(other) && count > 0) pairs.push({ id, other, count });
    }
  }
  return pairs
    .sort((a, b) => b.count - a.count || index.byId.get(a.id).order - index.byId.get(b.id).order)
    .slice(0, n);
}

// 混淆專練的字：這一組兩個字，再加上正解第二常誤選的字（同一種假名），最多 3 個
export function drillSet(state, index, id, other) {
  const ids = [id, other];
  const more = Object.entries(state.items[id]?.wrongWith || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .find((k) => !ids.includes(k) && index.byId.get(k)?.script === index.byId.get(id).script);
  if (more) ids.push(more);
  return ids;
}

// 混淆專練：只在這兩三個字之間出 10 題，輪流考，盡量不連續考同一個字；選項優先放這幾個字
export function buildDrillRound(data, state, ids, { rng = Math.random, enabledTypes, size = DRILL_SIZE } = {}) {
  const items = ids.map((id) => data.items.find((it) => it.id === id)).filter((it) => it && hasReading(it));
  if (!items.length) return { steps: [], newIds: [] };
  const types = (enabledTypes || ['A', 'B', 'C', 'E']).filter((t) => t !== 'D');
  const steps = [];
  let order = [];
  while (steps.length < size) {
    if (!order.length) {
      order = shuffle(items, rng);
      if (steps.length && items.length > 1 && order[0].id === steps[steps.length - 1].id) order.push(order.shift());
    }
    const it = order.shift();
    const type = pickType(it, Math.max(readLevel(state, it.id), TYPE_LEVEL), rng, types, state)
      || (canAsk(it, 'A') ? 'A' : null);
    if (type) steps.push({ kind: 'q', id: it.id, type, prefer: ids });
  }
  return { steps, newIds: [] };
}

// 出題與間隔重複邏輯的測試（對應 SPEC.md 第 14 節驗收檢查）。
// 執行：node --test tests/logic.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as srs from '../js/srs.js';
import * as quiz from '../js/quiz.js';
import * as write from '../js/write.js';
import * as wq from '../js/words.js';
import { freshState } from '../js/storage.js';

const data = JSON.parse(readFileSync(new URL('../data/kana-data.json', import.meta.url), 'utf8'));
const index = quiz.indexData(data);
const words = JSON.parse(readFileSync(new URL('../data/words.json', import.meta.url), 'utf8')).words;
const allUnits = data.units.map((u) => u.unit);
const hiraSeion = (u) => u && u.script === 'hira' && u.type === 'seion';

function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function stateWith(units) {
  return freshState(units);
}

test('考ぬ時，干擾選項包含 め、ね、あ 之中至少兩個', () => {
  const item = index.byId.get('h-nu');
  const state = stateWith(['hira-a', 'hira-na']);
  for (let seed = 1; seed <= 50; seed++) {
    for (const type of ['A', 'B']) {
      const { options } = quiz.buildChoices(item, type, { data, index, state, rng: seeded(seed) });
      assert.equal(options.length, 4);
      const labels = options.map((o) => o.label);
      assert.equal(new Set(labels).size, 4, '選項不重複');
      const wanted = type === 'A' ? ['me', 'ne', 'a'] : ['め', 'ね', 'あ'];
      assert.ok(wanted.filter((w) => labels.includes(w)).length >= 2, labels.join(','));
      assert.equal(options.filter((o) => o.correct).length, 1);
    }
  }
});

test('「看拼音選假名」與聽音題不會出 ぢ、づ、ヂ、ヅ', () => {
  for (const id of ['h-dji', 'h-dzu', 'k-dji', 'k-dzu']) {
    const item = index.byId.get(id);
    assert.equal(quiz.canAsk(item, 'B'), false);
    assert.equal(quiz.canAsk(item, 'C'), false);
    for (let seed = 1; seed <= 200; seed++) {
      const t = quiz.pickType(item, 4, seeded(seed));
      assert.ok(t !== 'B' && t !== 'C', t);
    }
  }
  // 新字的第二題也不能是 B／C
  const state = stateWith(['hira-dakuon']);
  state.settings.newPerDay = 30;
  const { steps } = quiz.buildRound(data, state, '2026-10-28', { rng: seeded(4) });
  const bad = steps.filter((s) => ['h-dji', 'h-dzu'].includes(s.id) && ['B', 'C'].includes(s.type));
  assert.deepEqual(bad, []);
});

test('平片對照（D）：對應字學過才出，選項全是另一種假名且含形近字', () => {
  const state = stateWith(['hira-a', 'hira-na', 'kata-a', 'kata-na']);
  const nu = index.byId.get('h-nu');
  assert.equal(quiz.canAsk(nu, 'D', state), false);
  state.items['k-nu'] = { read: { level: 1, due: '2026-10-29' } };
  assert.equal(quiz.canAsk(nu, 'D', state), true);
  for (let seed = 1; seed <= 30; seed++) {
    const { options, target } = quiz.buildChoices(nu, 'D', { data, index, state, rng: seeded(seed) });
    assert.equal(target.id, 'k-nu');
    assert.equal(options.find((o) => o.correct).label, 'ヌ');
    assert.ok(options.every((o) => o.id ? index.byId.get(o.id).script === 'kata' : true));
    const conf = index.byId.get('k-nu').confusables.map((c) => c.kana);
    assert.ok(options.filter((o) => conf.includes(o.label)).length >= 2);
  }
  assert.equal(quiz.canAsk(index.byId.get('k-chouon'), 'D', state), false);
});

test('誤選紀錄只用同一種假名補干擾項', () => {
  const state = stateWith(['hira-a', 'kata-a']);
  state.items['h-a'] = { wrongWith: { 'k-a': 9, 'k-i': 9 } };
  for (let seed = 1; seed <= 20; seed++) {
    const { options } = quiz.buildChoices(index.byId.get('h-a'), 'B', { data, index, state, rng: seeded(seed) });
    assert.ok(options.every((o) => !/[ァ-ヶ]/.test(o.label)), options.map((o) => o.label).join(','));
  }
});

test('特殊符號：只出說明卡，看過就不再當新字', () => {
  const day = '2026-10-28';
  const state = stateWith(['special']);
  const { steps, newIds } = quiz.buildRound(data, state, day, { rng: seeded(1) });
  assert.deepEqual(newIds, ['h-sokuon', 'k-sokuon', 'k-chouon']);
  assert.ok(steps.every((s) => s.kind === 'intro'));
  for (const id of newIds) state.items[id] = { seen: day };
  assert.equal(srs.newItemsAvailable(data.items, state).length, 0);
});

test('選項不出現與正解同音的字（を／お、じ／ぢ）', () => {
  const state = stateWith(data.units.map((u) => u.unit));
  const cases = [['h-o', 'A', 'wo'], ['h-wo', 'A', 'o'], ['h-o', 'B', 'を'], ['h-ji', 'B', 'ぢ'], ['h-zu', 'B', 'づ']];
  for (const [id, type, banned] of cases) {
    const item = index.byId.get(id);
    for (let seed = 1; seed <= 100; seed++) {
      // 刻意把同音字塞進 wrongWith，確認仍會被排除
      state.items[id] = { wrongWith: { 'h-wo': 9, 'h-o': 9, 'h-dji': 9, 'h-dzu': 9 } };
      const { options } = quiz.buildChoices(item, type, { data, index, state, rng: seeded(seed) });
      assert.ok(!options.some((o) => !o.correct && o.label === banned), `${id} ${type}: ${options.map((o) => o.label)}`);
    }
  }
});

test('選項不足時從 wrongWith 與同單位補滿 4 個', () => {
  const state = stateWith(['hira-a']);
  const item = index.byId.get('h-i'); // 只有 2 個形近字
  const { options } = quiz.buildChoices(item, 'A', { data, index, state, rng: seeded(3) });
  assert.equal(options.length, 4);
  state.items['h-i'] = { wrongWith: { 'h-u': 5 } };
  const again = quiz.buildChoices(item, 'A', { data, index, state, rng: seeded(3) });
  assert.ok(again.options.some((o) => o.label === 'u'), '最常誤選的字優先補進來');
});

test('打字題輸入 si、SHI（大寫加空白）都判 し 為正確', () => {
  const shi = index.byId.get('h-shi');
  assert.ok(quiz.checkTyped(shi, 'si'));
  assert.ok(quiz.checkTyped(shi, 'SHI '));
  assert.ok(quiz.checkTyped(shi, 'ｓｈｉ'), '全形英文');
  assert.ok(!quiz.checkTyped(shi, 'chi'));
  assert.ok(!quiz.checkTyped(shi, '   '));
  assert.ok(quiz.checkTyped(index.byId.get('h-wo'), 'o'), 'を 打字也接受 o');
});

test('答錯的字在同回合 3～5 題後再次出現', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const steps = Array.from({ length: 12 }, (_, i) => ({ kind: 'q', id: `x${i}`, type: 'A' }));
    steps.splice(2, 0, { kind: 'intro', id: 'n1' });
    const s = new quiz.Session(steps, { rng: seeded(seed) });
    s.record({ id: 'x0', correct: false });
    const qs = s.steps.filter((st) => st.kind === 'q');
    const gap = qs.findIndex((st, i) => i > 0 && st.id === 'x0');
    assert.ok(gap >= 3 && gap <= 5, `gap=${gap}`);
  }
});

test('回合尾端答錯時，用其他字補題後再重考', () => {
  const steps = [{ kind: 'q', id: 'a', type: 'A' }, { kind: 'q', id: 'b', type: 'A' }, { kind: 'q', id: 'c', type: 'A' }];
  const s = new quiz.Session(steps, { rng: seeded(7) });
  s.advance(); s.advance();
  s.record({ id: 'c', correct: false });
  const after = s.steps.slice(3);
  const gap = after.findIndex((st) => st.id === 'c') + 1;
  assert.ok(gap >= 2, `gap=${gap}`); // 只有 2 個其他字可補時至少隔開
  assert.equal(after[after.length - 1].id, 'c');
});

test('同一天反覆答對，等級最多只升一級', () => {
  const day = '2026-10-28';
  let track;
  let ups = 0;
  for (let i = 0; i < 5; i++) {
    const r = srs.applyAnswer(track, { correct: true, fast: true, ms: 900 }, day);
    track = r.track;
    if (r.leveledUp) ups++;
  }
  assert.equal(track.level, 1);
  assert.equal(ups, 1);
  track = srs.applyAnswer(track, { correct: true, fast: true }, '2026-10-29').track;
  assert.equal(track.level, 2);
});

test('Leitner 排程：慢答不升級、答錯回 1 級、5 級再答對即精熟', () => {
  let t = { level: 3, due: '2026-10-28', streak: 2 };
  t = srs.applyAnswer(t, { correct: true, fast: false }, '2026-10-28').track;
  assert.equal(t.level, 3);
  assert.equal(t.due, '2026-10-31');
  t = srs.applyAnswer(t, { correct: true, fast: true }, '2026-10-31').track;
  assert.equal(t.level, 4);
  assert.equal(t.due, '2026-11-07');
  t = srs.applyAnswer(t, { correct: false }, '2026-11-07').track;
  assert.equal(t.level, 1);
  assert.equal(t.due, '2026-11-08');
  t = srs.applyAnswer({ level: 5 }, { correct: true, fast: true }, '2026-12-01').track;
  assert.equal(t.mastered, true);
  assert.equal(t.due, '2026-12-31');
});

test('一天的分界是凌晨 4:00', () => {
  assert.equal(srs.today(new Date(2026, 9, 29, 3, 59)), '2026-10-28');
  assert.equal(srs.today(new Date(2026, 9, 29, 4, 0)), '2026-10-29');
  assert.equal(srs.addDays('2026-12-31', 1), '2027-01-01');
});

test('已解鎖項目 read 皆 ≥ 3 時，自動解鎖下一行', () => {
  const state = stateWith(['hira-a']);
  const aRow = data.items.filter((it) => it.unit === 'hira-a');
  aRow.forEach((it, i) => { state.items[it.id] = { read: { level: i === 0 ? 2 : 3 } }; });
  assert.deepEqual(srs.autoUnlock(data, state, { enabled: hiraSeion }), []);
  state.items[aRow[0].id].read.level = 3;
  assert.deepEqual(srs.autoUnlock(data, state, { enabled: hiraSeion }), ['hira-ka']);
  assert.deepEqual(state.unlocked, ['hira-a', 'hira-ka']);
  // か行還是新字，不會連續解鎖
  assert.deepEqual(srs.autoUnlock(data, state, { enabled: hiraSeion }), []);
});

test('全部單位都解鎖後不再解鎖；特殊符號不擋解鎖', () => {
  const state = stateWith(data.units.map((u) => u.unit));
  for (const it of data.items) if (srs.hasReading(it)) state.items[it.id] = { read: { level: 5 } };
  assert.ok(srs.readyToUnlock(data.items, state), '促音、長音沒有 read 等級也不影響');
  assert.deepEqual(srs.autoUnlock(data, state), []);
});

test('平片同步學：同一行一起解鎖', () => {
  const groups = srs.unitGroups(data.units, true);
  assert.deepEqual(groups[0], ['hira-a', 'kata-a']);
  assert.deepEqual(groups[10], ['hira-dakuon', 'kata-dakuon']);
  assert.deepEqual(groups[groups.length - 1], ['special']);
});

test('今日回合：新字先認識卡再接 2 題，每日上限 5 個', () => {
  const day = '2026-10-28';
  const state = stateWith(['hira-a', 'hira-ka']);
  const { steps, newIds } = quiz.buildRound(data, state, day, { rng: seeded(1) });
  assert.equal(newIds.length, 5);
  assert.deepEqual(newIds, ['h-a', 'h-i', 'h-u', 'h-e', 'h-o']);
  for (const id of newIds) {
    const idx = steps.findIndex((s) => s.id === id);
    assert.equal(steps[idx].kind, 'intro', '認識卡在前');
    assert.equal(steps.filter((s) => s.id === id && s.kind === 'q').length, 2);
  }
  // 今天已用掉額度就不再給新字
  state.log[day] = { newItems: 5 };
  assert.equal(quiz.buildRound(data, state, day).newIds.length, 0);
});

test('今日回合：到期複習在前，最多 20 題', () => {
  const day = '2026-10-28';
  const state = stateWith(data.units.filter(hiraSeion).map((u) => u.unit));
  for (const it of data.items.filter((x) => hiraSeion(data.units.find((u) => u.unit === x.unit)))) {
    state.items[it.id] = { read: { level: 3, due: '2026-10-27' } };
  }
  const reads = quiz.buildRound(data, state, day, { rng: seeded(2) }).steps.filter((s) => s.type !== 'F');
  assert.equal(reads.length, 20);
  assert.ok(reads.every((s) => s.kind === 'q' && quiz.ALL_TYPES.includes(s.type)));
});

// ---------- 書寫（階段三） ----------

test('書寫軌：學過的隔天才開放；ぢ、づ、ヂ、ヅ 與促音、長音不出書寫題', () => {
  const day = '2026-10-28';
  const state = stateWith(data.units.map((u) => u.unit));
  const nu = index.byId.get('h-nu');
  assert.equal(srs.writeOpen(nu, state, day), false, '還沒學過');
  // 今天第一次學（答得慢也一樣進排程）：今天還不能寫，隔天就能寫
  state.items['h-nu'] = { read: srs.applyAnswer(undefined, { correct: true, fast: false }, day).track };
  assert.equal(state.items['h-nu'].read.since, day);
  assert.equal(srs.writeOpen(nu, state, day), false, '當天剛學');
  assert.equal(srs.writeOpen(nu, state, '2026-10-29'), true, '隔天開放');
  // 之後答錯掉回 1 級，第一次學的日子不變，仍可以寫
  state.items['h-nu'].read = srs.applyAnswer(state.items['h-nu'].read, { correct: false }, '2026-10-30').track;
  assert.equal(state.items['h-nu'].read.since, day);
  assert.equal(srs.writeOpen(nu, state, '2026-10-30'), true);
  // 舊資料沒有 since：視為早就學過
  state.items['h-ne'] = { read: { level: 1, due: '2026-10-29' } };
  assert.equal(srs.writeOpen(index.byId.get('h-ne'), state, day), true);
  for (const id of ['h-dji', 'h-dzu', 'k-dji', 'k-dzu', 'h-sokuon', 'k-sokuon', 'k-chouon']) {
    assert.equal(srs.canWrite(index.byId.get(id)), false, id);
  }
  assert.equal(srs.canWrite(index.byId.get('h-kya')), true, '拗音考小字位置');
});

test('書寫自評：寫對升級、大致對不變、寫錯回 1 級；同一天只升一次', () => {
  let t = srs.applyWrite({ level: 2, due: '2026-10-28' }, 'right', '2026-10-28').track;
  assert.equal(t.level, 3);
  assert.equal(t.due, '2026-10-31');
  t = srs.applyWrite(t, 'right', '2026-10-28').track;
  assert.equal(t.level, 3, '同一天不再升');
  t = srs.applyWrite(t, 'unsure', '2026-10-31').track;
  assert.equal(t.level, 3);
  t = srs.applyWrite(t, 'wrong', '2026-10-31').track;
  assert.equal(t.level, 1);
  assert.equal(srs.applyWrite(undefined, 'unsure', '2026-10-28').track.level, 1, '第一次寫就進排程');
});

test('今天要寫的字：到期的在前、剛開放的在後，未到期的不列入', () => {
  const day = '2026-10-28';
  const state = stateWith(['hira-a']);
  for (const it of data.items.filter((x) => x.unit === 'hira-a')) state.items[it.id] = { read: { level: 3 } };
  state.items['h-a'].write = { level: 2, due: '2026-10-30' };
  state.items['h-i'].write = { level: 1, due: '2026-10-27' };
  state.items['h-u'].read = { level: 1, since: day };
  const ids = srs.dueWriteItems(data.items, state, day).map((it) => it.id);
  assert.deepEqual(ids, ['h-i', 'h-e', 'h-o']);
});

test('今日回合：書寫題排在最後、最多 8 題，認讀複習很多時也保留名額', () => {
  const day = '2026-10-28';
  const units = data.units.filter(hiraSeion).map((u) => u.unit);
  const state = stateWith(units);
  for (const it of data.items.filter((x) => units.includes(x.unit))) {
    state.items[it.id] = { read: { level: 3, due: '2026-10-27' } };
  }
  const { steps } = quiz.buildRound(data, state, day, { rng: seeded(5) });
  assert.equal(steps.length, 28, '認讀複習 20 題＋書寫 8 題');
  const w = steps.filter((s) => s.type === 'F');
  assert.equal(w.length, 8);
  assert.ok(steps.slice(-8).every((s) => s.type === 'F'), '書寫在最後');
  assert.ok(w.every((s) => srs.writeOpen(index.byId.get(s.id), state, day)));
  assert.equal(steps.filter((s) => s.type !== 'F').length, 20);

  // 20 題的回合只保留 5 題給書寫
  state.settings.roundSize = 20;
  const small = quiz.buildRound(data, state, day, { rng: seeded(5) }).steps;
  assert.equal(small.filter((s) => s.type === 'F').length, 5);
  assert.equal(small.length, 20);

  // 全新的使用者：今天學的新字不出書寫題
  const beginner = stateWith(['hira-a']);
  const first = quiz.buildRound(data, beginner, day, { rng: seeded(1) });
  assert.ok(first.newIds.length > 0);
  assert.equal(first.steps.filter((s) => s.type === 'F').length, 0);
  for (const id of first.newIds) beginner.items[id] = { read: srs.applyAnswer(undefined, { correct: true, fast: true }, day).track };
  assert.equal(quiz.buildRound(data, beginner, day).steps.filter((s) => s.type === 'F').length, 0, '當天加練也不出');
  const next = quiz.buildRound(data, beginner, '2026-10-29', { rng: seeded(1) }).steps.filter((s) => s.type === 'F');
  assert.equal(next.length, first.newIds.length, '隔天就排進書寫題');
});

test('書寫頁練習：先寫到期的，都寫完就挑等級低的字加練', () => {
  const day = '2026-10-28';
  const state = stateWith(['hira-a']);
  for (const it of data.items.filter((x) => x.unit === 'hira-a')) {
    state.items[it.id] = { read: { level: 3 }, write: { level: 3, due: '2026-11-01' } };
  }
  state.items['h-e'].write.due = '2026-10-28';
  assert.deepEqual(quiz.buildWriteRound(data, state, day).steps.map((s) => s.id), ['h-e']);
  state.items['h-e'].write.due = '2026-11-01';
  const extra = quiz.buildWriteRound(data, state, day, { rng: seeded(2) }).steps;
  assert.equal(extra.length, 5);
  assert.ok(extra.every((s) => s.type === 'F'));
});

test('答錯的書寫題同回合再考一次', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({ kind: 'q', id: `w${i}`, type: 'F' }));
  const s = new quiz.Session(steps, { rng: seeded(3) });
  s.record({ id: 'w0', type: 'F', correct: false });
  const again = s.steps.findIndex((st, i) => i > 0 && st.id === 'w0');
  assert.ok(again >= 3 && again <= 5);
  assert.equal(s.steps[again].type, 'F');
});

test('KanjiVG 筆順檔：142 個清音、濁音、半濁音都在，筆數與筆順數字一致', () => {
  const kana = data.items.filter((it) => ['seion', 'dakuon', 'handakuon'].includes(it.type));
  assert.equal(kana.length, 142);
  assert.equal(write.strokeFile('あ'), 'strokes/03042.svg');
  for (const it of kana) {
    const svg = readFileSync(new URL(`../${write.strokeFile(it.kana)}`, import.meta.url), 'utf8');
    const strokes = write.parseKanjiVG(svg);
    assert.ok(strokes.length >= 1, it.kana);
    assert.ok(strokes.every((st) => st.d.startsWith('M') && st.label), it.kana);
  }
  assert.equal(write.parseKanjiVG(readFileSync(new URL('../strokes/03042.svg', import.meta.url), 'utf8')).length, 3, 'あ 三筆');
  assert.equal(write.parseKanjiVG(readFileSync(new URL('../strokes/03071.svg', import.meta.url), 'utf8')).length, 4, 'ぱ 四筆');
  assert.equal(write.hasStrokeData('きゃ'), false);
});

// ---------- 階段四：單字與統計 ----------

test('單字題不會出現含未解鎖假名的單字', () => {
  const units = [];
  for (const u of allUnits) {
    units.push(u);
    const state = stateWith(units);
    state.settings.roundSize = 50;
    const unlocked = new Set(units);
    const ok = (w) => w.requires.every((id) => unlocked.has(index.byId.get(id).unit));
    assert.ok(wq.availableWords(words, index, state).every(ok));
    for (let seed = 1; seed <= 5; seed++) {
      const { steps } = wq.buildWordRound(words, index, state, { rng: seeded(seed) });
      for (const s of steps) assert.ok(ok(words.find((w) => w.word === s.id)), `${u}: ${s.id}`);
      // 今日練習補題也一樣
      const round = quiz.buildRound(data, state, '2026-10-28', { rng: seeded(seed), words, index });
      for (const s of round.steps.filter((x) => x.word)) assert.ok(ok(words.find((w) => w.word === s.id)), s.id);
    }
  }
});

test('解鎖不足 5 個單字時，算出還要再解鎖幾行', () => {
  const state = stateWith(['hira-a']);
  const n = wq.rowsUntilWords(data, words, index, state);
  assert.ok(n > 0);
  const more = stateWith(allUnits.slice(0, 1 + n));
  assert.ok(wq.availableWords(words, index, more).length >= wq.MIN_WORDS);
  const less = stateWith(allUnits.slice(0, n));
  assert.ok(wq.availableWords(words, index, less).length < wq.MIN_WORDS);
  assert.equal(wq.rowsUntilWords(data, words, index, more), 0);
});

test('斷字轉拼音：69 個單字都和標準答案一致（含促音、長音、拗音）', () => {
  for (const w of words) {
    const tokens = wq.tokenize(w.word, index);
    assert.ok(tokens.every((t) => t.id), w.word);
    assert.equal(wq.tokensToRomaji(tokens), w.romaji, w.word);
    assert.deepEqual([...new Set(tokens.map((t) => t.id))].sort(), [...w.requires].sort(), w.word);
  }
});

test('長音 normalize：ō、ou、ū、uu、â 都接受，大小寫與空白不影響', () => {
  const find = (k) => words.find((w) => w.word === k);
  const cases = {
    'コーヒー': ['koohii', 'kōhii', 'kouhii', 'KŌHII ', 'kôhii'],
    'ジュース': ['juusu', 'jūsu', 'JŪSU', ' juu su '],
    'きょう': ['kyou', 'kyō', 'kyoo'],
    'ラーメン': ['raamen', 'rāmen', 'râmen'],
    'ろうそく': ['rousoku', 'rōsoku', 'roosoku'],
  };
  for (const [k, list] of Object.entries(cases)) {
    for (const v of list) assert.ok(wq.checkWordTyped(find(k), v), `${k} ${v}`);
  }
  assert.equal(wq.checkWordTyped(find('コーヒー'), 'kohii'), false, '漏掉長音算錯');
  assert.equal(wq.checkWordTyped(find('ラーメン'), ''), false);
  assert.equal(wq.normalizeWordRomaji('ＫＯＯＨＩＩ'), 'koohii');
});

test('單字選拼音：干擾項是把 1 個假名換成形近字的拼音，選項不重複', () => {
  const state = stateWith(allUnits);
  const neko = words.find((w) => w.word === 'ねこ');
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const { options } = wq.buildWordChoices(neko, { data, index, state, rng: seeded(seed) });
    assert.equal(options.length, 4);
    assert.equal(options.filter((o) => o.correct).length, 1);
    assert.equal(new Set(options.map((o) => wq.normalizeWordRomaji(o.label))).size, 4);
    for (const o of options.filter((x) => !x.correct)) seen.add(o.kana);
  }
  assert.ok(['れこ', 'ぬこ', 'わこ'].some((k) => seen.has(k)), [...seen].join(','));
  for (const k of seen) assert.equal([...k].length, 2, k);

  // 每個單字在剛解鎖的狀態下也湊得滿 4 個選項
  for (const w of words) {
    const units = [...new Set(w.requires.map((id) => index.byId.get(id).unit))];
    const { options } = wq.buildWordChoices(w, { data, index, state: stateWith(units), rng: seeded(3) });
    assert.equal(options.length, 4, w.word);
  }
});

test('促音、長音的單字：干擾項包含漏掉促音或長音的寫法', () => {
  const state = stateWith(allUnits);
  const labels = (k) => {
    const w = words.find((x) => x.word === k);
    const all = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      wq.buildWordChoices(w, { data, index, state, rng: seeded(seed) }).options.forEach((o) => all.add(o.label));
    }
    return all;
  };
  assert.ok(labels('コーヒー').has('kohii'));
  const k = labels('きって');
  assert.ok(k.has('kite') && k.has('kitsute'), [...k].join(','));
});

test('答錯的單字：把其中 read 等級最低的假名排進下一回合', () => {
  const state = stateWith(allUnits.slice(0, 5));
  const neko = words.find((w) => w.word === 'ねこ');
  state.items['h-ne'] = { read: { level: 4, due: '2026-11-05' } };
  state.items['h-ko'] = { read: { level: 2, due: '2026-11-05' } };
  assert.equal(wq.addFocus(state, neko, index), 'h-ko');
  assert.deepEqual(state.focus, ['h-ko']);
  // こ 還沒到期，但下一回合會出現
  const { steps } = quiz.buildRound(data, state, '2026-10-28', { rng: seeded(2) });
  assert.ok(steps.some((s) => s.id === 'h-ko' && s.kind === 'q'));
  // 促音、長音不會被排進來
  const kitte = words.find((w) => w.word === 'きって');
  const st2 = stateWith(allUnits);
  st2.items['h-ki'] = { read: { level: 3 } };
  st2.items['h-te'] = { read: { level: 1 } };
  assert.equal(wq.weakestKana(kitte, index, st2).id, 'h-te');
});

test('今日練習：認讀、新字、書寫都排完仍不足回合題數時，用單字題補滿', () => {
  const state = stateWith(allUnits.slice(0, 5));
  for (const it of srs.unlockedItems(data.items, state.unlocked)) {
    state.items[it.id] = { read: { level: 3, due: '2026-11-20', since: '2026-10-01' }, write: { level: 3, due: '2026-11-20' } };
  }
  state.items['h-a'].read.due = '2026-10-28';
  const { steps } = quiz.buildRound(data, state, '2026-10-28', { rng: seeded(1), words, index });
  const avail = wq.availableWords(words, index, state).length;
  assert.equal(steps.filter((s) => s.kind === 'q').length, Math.min(30, 1 + avail));
  assert.equal(steps[0].id, 'h-a');
  assert.ok(steps.slice(1).every((s) => s.word && ['W', 'S', 'T'].includes(s.type)));
  // 沒傳單字就不補
  assert.equal(quiz.buildRound(data, state, '2026-10-28', { rng: seeded(1) }).steps.length, 1);
});

test('單字題型：選拼音、唸讀自評輪替；假名都到 3 級才出打字', () => {
  const state = stateWith(allUnits);
  const neko = words.find((w) => w.word === 'ねこ');
  assert.deepEqual(wq.wordTypes(neko, index, state), ['W', 'S']);
  state.items['h-ne'] = { read: { level: 3 } };
  state.items['h-ko'] = { read: { level: 5 } };
  assert.deepEqual(wq.wordTypes(neko, index, state), ['W', 'S', 'T']);

  const st = stateWith(allUnits);
  const { steps } = wq.buildWordRound(words, index, st, { rng: seeded(5) });
  assert.equal(steps.length, wq.WORD_ROUND_SIZE);
  assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, '同一回合不重複');
  assert.ok(steps.some((s) => s.type === 'W') && steps.some((s) => s.type === 'S'));
  assert.ok(steps.every((s) => s.type !== 'T'));

  // 沒讀過的單字優先
  st.words = Object.fromEntries(words.slice(0, 60).map((w) => [w.word, { last: '2026-10-20' }]));
  const ids = wq.buildWordRound(words, index, st, { rng: seeded(5) }).steps.map((s) => s.id);
  for (const w of words.slice(60)) assert.ok(ids.includes(w.word), w.word);
});

test('答錯的單字題同回合再考；補題用其他單字', () => {
  const steps = [{ kind: 'q', word: true, id: 'ねこ', type: 'W' }, { kind: 'q', word: true, id: 'いぬ', type: 'S' }];
  const s = new quiz.Session(steps, { rng: seeded(1) });
  s.record({ id: 'ねこ', word: true, correct: false });
  assert.ok(s.steps.every((x) => x.word));
  assert.equal(s.steps.at(-1).id, 'ねこ');
  assert.equal(s.steps.at(-1).type, 'W');
  assert.deepEqual(s.summary().wrongWords, ['ねこ']);
  assert.deepEqual(s.summary().wrong, []);
});

test('最常混淆的字組：依 wrongWith 排序，最多 10 組', () => {
  const state = stateWith(allUnits);
  state.items['h-nu'] = { wrongWith: { 'h-me': 4, 'h-ne': 1 } };
  state.items['h-sa'] = { wrongWith: { 'h-chi': 2 } };
  state.items['h-a'] = { wrongWith: Object.fromEntries(['h-i', 'h-u', 'h-e', 'h-o', 'h-ka', 'h-ki', 'h-ku', 'h-ke', 'h-ko'].map((id) => [id, 1])) };
  const top = wq.topConfusions(state, index);
  assert.equal(top.length, 10);
  assert.deepEqual(top[0], { id: 'h-nu', other: 'h-me', count: 4 });
  assert.deepEqual(top[1], { id: 'h-sa', other: 'h-chi', count: 2 });
  assert.deepEqual(wq.drillSet(state, index, 'h-nu', 'h-me'), ['h-nu', 'h-me', 'h-ne']);
});

test('混淆專練：10 題只考這兩三個字，選項包含它們，不連續考同一個字', () => {
  const state = stateWith(allUnits);
  state.items['h-nu'] = { read: { level: 2 }, wrongWith: { 'h-me': 4 } };
  state.items['h-me'] = { read: { level: 1 } };
  const ids = ['h-nu', 'h-me'];
  for (let seed = 1; seed <= 20; seed++) {
    const { steps } = wq.buildDrillRound(data, state, ids, { rng: seeded(seed), enabledTypes: quiz.ALL_TYPES });
    assert.equal(steps.length, wq.DRILL_SIZE);
    assert.ok(steps.every((s) => ids.includes(s.id) && s.type !== 'D'));
    for (let i = 1; i < steps.length; i++) assert.notEqual(steps[i].id, steps[i - 1].id);
    for (const s of steps.filter((x) => x.type !== 'E')) {
      const { options } = quiz.buildChoices(index.byId.get(s.id), s.type, { data, index, state, rng: seeded(seed), prefer: s.prefer });
      const labels = options.map((o) => o.label);
      const want = s.type === 'A' ? ['nu', 'me'] : ['ぬ', 'め'];
      assert.ok(want.every((w) => labels.includes(w)), labels.join(','));
    }
  }
});

test('答題紀錄：applyAnswer 累計作答與答對次數', () => {
  let t = srs.applyAnswer(undefined, { correct: true, fast: true, ms: 900 }, '2026-10-28').track;
  t = srs.applyAnswer(t, { correct: false, fast: false, ms: 3000 }, '2026-10-28').track;
  assert.equal(t.n, 2);
  assert.equal(t.ok, 1);
});

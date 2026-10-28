// 出題與間隔重複邏輯的測試（對應 SPEC.md 第 14 節驗收檢查）。
// 執行：node --test tests/logic.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as srs from '../js/srs.js';
import * as quiz from '../js/quiz.js';
import { freshState } from '../js/storage.js';

const data = JSON.parse(readFileSync(new URL('../data/kana-data.json', import.meta.url), 'utf8'));
const index = quiz.indexData(data);
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
  const { steps } = quiz.buildRound(data, state, day, { rng: seeded(2) });
  assert.equal(steps.length, 20);
  assert.ok(steps.every((s) => s.kind === 'q' && quiz.ALL_TYPES.includes(s.type)));
});

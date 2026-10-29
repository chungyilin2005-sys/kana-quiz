// 路由與畫面。畫面用 hash 切換：#today、#practice、#write、#words、#stats、#settings。

import * as store from './storage.js';
import * as srs from './srs.js';
import * as quiz from './quiz.js';
import * as tts from './tts.js';
import * as write from './write.js';
import * as wq from './words.js';

const CORRECT_PAUSE_MS = 600;
const BACKUP_REMIND_DAYS = 7;
const WEEKDAYS = '日一二三四五六';

const scriptName = (script) => (script === 'hira' ? '平假名' : '片假名');
const otherScript = (script) => (script === 'hira' ? 'kata' : 'hira');

const PROMPTS = {
  A: () => '這個字怎麼念？',
  B: (item) => `選出這個讀音的${scriptName(item.script)}`,
  C: (item) => `聽到的是哪個${scriptName(item.script)}？`,
  D: (item) => `選出對應的${scriptName(otherScript(item.script))}`,
  E: () => '輸入羅馬拼音',
  F: (item) => `寫出${scriptName(item.script)}`,
};

const WORD_PROMPTS = {
  W: '這個單字怎麼念？',
  S: '先自己唸出來，再聽答案',
  T: '輸入這個單字的羅馬拼音',
};

const WRITE_GRADES = [
  ['right', '寫對', 'btn btn-primary'],
  ['unsure', '大致對但不確定', 'btn'],
  ['wrong', '寫錯或想不起來', 'btn'],
];

let data;
let words = [];
let wordIndex = new Map();
let index;
let state;
let session = null;
let keyHandler = null;

const view = document.getElementById('view');

// ---------- 小工具 ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function mount(...nodes) {
  view.append(...nodes.filter((n) => n != null && n !== false));
}

function persist() {
  store.saveState(state);
}

function dayLog(day) {
  state.log[day] ||= { q: 0, correct: 0, ms: 0, newItems: 0, rounds: 0 };
  return state.log[day];
}

function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}

function unitLabel(name) {
  const u = data.units.find((x) => x.unit === name);
  if (!u) return name;
  if (u.type === 'seion') return `${data.items.find((it) => it.unit === name).kana}行`;
  if (u.type.startsWith('dakuon')) return `${scriptName(u.script)}濁音`;
  if (u.type === 'yoon') return `${scriptName(u.script)}拗音`;
  return '特殊符號';
}

function enabledTypes() {
  return quiz.ALL_TYPES.filter((t) => t !== 'C' || tts.getStatus() === 'ok');
}

function say(text) {
  if (tts.getStatus() !== 'ok') return Promise.resolve(false);
  return tts.speak(text, { rate: state.settings.ttsRate });
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

function setPage(route) {
  document.body.classList.toggle('in-practice', route === 'practice');
  for (const a of document.querySelectorAll('#tabbar a')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  keyHandler = null;
  tts.stop();
  // 只有書寫題要擋下拉重新整理，其他畫面照常
  document.documentElement.classList.remove('no-overscroll');
  view.replaceChildren();
  window.scrollTo(0, 0);
}

// 依字數調整田字格裡的字級（拗音兩個字要縮小）
function boardChar(text, { romaji = false } = {}) {
  const cls = ['board-char'];
  if (romaji) cls.push('romaji');
  else if ([...text].length > 1) cls.push('long');
  return el('span', { class: cls.join(' '), lang: romaji ? 'en' : 'ja', text });
}

function maruSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'maru');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  // 起筆在右上、略微不閉合，像老師手畫的圈
  path.setAttribute('d', 'M66 11 C90 20 98 58 80 79 C62 98 24 96 11 72 C-1 48 14 14 46 9 C54 8 61 9 68 13');
  path.setAttribute('pathLength', '1');
  svg.append(path);
  return svg;
}

function speakerButton(text, { big = false } = {}) {
  if (tts.getStatus() !== 'ok') return null;
  return el('button', {
    class: big ? 'speaker speaker-big' : 'speaker',
    type: 'button',
    'aria-label': '播放讀音',
    onclick: () => say(text),
  }, '🔊');
}

// ---------- 路由 ----------

function route() {
  const name = (location.hash || '#today').slice(1);
  if (name === 'practice') return session ? renderPractice() : go('today');
  if (name === 'settings') return renderSettings();
  if (name === 'write') return renderWritePage();
  if (name === 'words') return renderWordsPage();
  if (name === 'stats') return renderStats();
  return renderToday();
}

function go(name) {
  if (location.hash === `#${name}`) route();
  else location.hash = `#${name}`;
}

document.addEventListener('keydown', (e) => {
  if (keyHandler && !e.altKey && !e.ctrlKey && !e.metaKey) keyHandler(e);
});

// ---------- 首頁 ----------

function renderToday() {
  setPage('today');
  const day = srs.today();

  const unlocked = srs.autoUnlock(data, state);
  if (unlocked.length) {
    persist();
    toast(`解鎖了：${unlocked.map(unitLabel).join('、')}`);
  }

  const due = srs.dueReadItems(data.items, state, day).length;
  const writeDue = srs.dueWriteItems(data.items, state, day).length;
  const newAvail = srs.newItemsAvailable(data.items, state).length;
  const newToday = Math.min(srs.newQuotaLeft(state, day), newAvail);
  const streak = srs.streakDays(state, day);
  const hasWork = due > 0 || newToday > 0 || writeDue > 0;

  const [y, m, d] = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];

  const start = el('button', {
    class: 'btn btn-primary btn-big',
    onclick: () => startRound(hasWork ? 'today' : 'extra'),
  }, hasWork ? '開始今日練習' : '加練一回合');

  const learned = data.items.some((it) => srs.readLevel(state, it.id) > 0);

  mount(
    el('header', { class: 'masthead' },
      el('h1', {}, '50音練習帖'),
      el('p', { class: 'date' }, `${m}月${d}日（${weekday}）`),
    ),
    backupReminder(day),
    el('div', { class: 'tally' },
      el('div', {},
        el('span', { class: 'num' }, due + writeDue),
        el('span', { class: 'label' }, '待複習'),
        el('span', { class: 'sub' }, '認讀 ', due, '・書寫 ', writeDue),
      ),
      el('div', {},
        el('span', { class: 'num' }, newToday),
        el('span', { class: 'label' }, '今日新字'),
      ),
      el('div', {},
        el('span', { class: 'num' }, streak),
        el('span', { class: 'label' }, '連續天數'),
      ),
    ),
    !hasWork && learned ? el('p', { class: 'done-note' }, '今天的練習都完成了，明天再來！') : null,
    start,
    progressSection(),
  );

  keyHandler = (e) => {
    if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); start.click(); }
  };
}

// 每 7 天提醒一次備份：從最後一次匯出、上次提醒、第一次練習三者中最晚的那天算起
function backupReminder(day) {
  const practiced = Object.keys(state.log).filter((d) => (state.log[d]?.q ?? 0) > 0).sort();
  if (!practiced.length) return null;
  const base = [practiced[0], state.backup?.lastExport, state.backup?.lastRemind].filter(Boolean).sort().pop();
  if (daysBetween(base, day) < BACKUP_REMIND_DAYS) return null;

  const box = el('div', { class: 'notice' },
    el('p', {}, '進度只存在這個瀏覽器，換手機或清除瀏覽資料就會消失。建議匯出一份備份。'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => { exportProgress(); box.remove(); } }, '匯出備份'),
      el('button', {
        class: 'btn',
        onclick: () => {
          state.backup = { ...state.backup, lastRemind: day };
          persist();
          box.remove();
        },
      }, '下次再說'),
    ),
  );
  return box;
}

function progressSection() {
  const have = new Set(state.unlocked);
  const next = srs.nextUnitGroup(data.units, state.unlocked, { sync: state.settings.syncScripts });
  const pool = srs.unlockedItems(data.items, state.unlocked).filter(srs.hasReading);
  const ready = pool.filter((it) => srs.readLevel(state, it.id) >= srs.UNLOCK_LEVEL).length;
  const below = pool.length - ready;

  const groups = [
    ['平假名', (u) => u.script === 'hira' && u.type === 'seion'],
    ['片假名', (u) => u.script === 'kata' && u.type === 'seion'],
    ['濁音・拗音・特殊符號', (u) => u.type !== 'seion'],
  ];

  return el('section', { class: 'section' },
    el('h2', {}, '學習進度'),
    groups.map(([title, test]) => el('div', { class: 'unit-group' },
      el('h3', {}, title),
      el('ul', { class: 'unit-list', lang: 'ja' },
        data.units.filter(test).map((u) => el('li', { class: have.has(u.unit) ? '' : 'locked' }, unitLabel(u.unit)))),
    )),
    next
      ? el('div', {},
        el('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': pool.length, 'aria-valuenow': ready },
          el('span', { style: `width:${pool.length ? (ready / pool.length) * 100 : 0}%` })),
        el('p', { class: 'muted' },
          `下一個解鎖：${next.map(unitLabel).join('、')}。下面這些字都「記住」後就會開放，還差 ${below} 個字。`),
        levelChips(pool.filter((it) => srs.readLevel(state, it.id) < srs.UNLOCK_LEVEL)),
        el('details', { class: 'level-help' },
          el('summary', {}, '怎樣才算「記住」？'),
          el('p', {}, '每個字有 0～5 級。答對而且夠快（選擇題 2.5 秒、打字 4 秒內）就升一級，但同一個字一天最多升一級；答錯會掉回 1 級。'),
          el('p', {}, '升到 3 級就算記住，也就是在不同的 3 天都答對。字下面的格子表示目前到第幾級。'),
        ),
      )
      : el('p', { class: 'muted' }, '所有單位都解鎖了！'),
  );
}

// 還沒記住的字，下面用 3 格表示目前等級（滿 3 格就算記住）
function levelChips(items) {
  if (!items.length) return null;
  return el('ul', { class: 'level-chips' },
    items.map((it) => {
      const level = srs.readLevel(state, it.id);
      return el('li', { title: `${it.romaji}：${level} 級` },
        el('span', { class: 'k', lang: 'ja' }, it.kana),
        el('span', { class: 'pips', 'aria-label': `${level} 級` },
          [1, 2, 3].map((n) => el('i', { class: n <= level ? 'on' : '' }))),
      );
    }),
  );
}

// ---------- 練習回合 ----------

// mode：today 今日練習、extra 加練、write 書寫頁的單獨練習、words 單字閱讀、drill 混淆專練（傳入字的 id）
async function startRound(mode = 'today', drillIds = []) {
  // iOS 要在點擊當下先發聲一次，之後的語音才會出聲
  tts.unlock();
  await tts.ready();

  const day = srs.today();
  const opts = { enabledTypes: enabledTypes() };
  let round;
  if (mode === 'extra') round = quiz.buildExtraRound(data, state, opts);
  else if (mode === 'write') round = quiz.buildWriteRound(data, state, day);
  else if (mode === 'words') round = wq.buildWordRound(words, index, state);
  else if (mode === 'drill') round = wq.buildDrillRound(data, state, drillIds, opts);
  else round = quiz.buildRound(data, state, day, { ...opts, words, index });

  if (!round.steps.length) {
    toast(mode === 'words' ? '目前沒有可以讀的單字' : '目前沒有可以練習的字');
    return;
  }
  // 單字答錯排進來的弱字，排進這回合後就從待練清單移除
  if (state.focus?.length) {
    const used = new Set(round.steps.filter((s) => !s.word).map((s) => s.id));
    state.focus = state.focus.filter((id) => !used.has(id));
    persist();
  }
  session = new quiz.Session(round.steps, { extra: mode !== 'today' });
  session.introduced = new Set();
  session.home = { write: 'write', words: 'words', drill: 'stats' }[mode] || 'today';
  go('practice');
}

function renderPractice() {
  setPage('practice');
  if (session.done) return renderSummary();

  const step = session.current;
  const total = session.questionTotal;
  const num = step.kind === 'q' ? session.questionNumber : session.questionNumber + 1;

  mount(
    el('div', { class: 'practice-top' },
      el('button', { class: 'icon-btn', 'aria-label': '結束這回合', onclick: quitRound }, '×'),
      el('div', { class: 'meter' }, el('span', { style: `width:${((num - 1) / Math.max(total, 1)) * 100}%` })),
      el('span', { class: 'progress-text' }, total ? `${Math.min(num, total)} / ${total}` : ''),
    ),
  );

  if (step.kind === 'intro') renderIntro(step);
  else if (step.word) renderWordQuestion(step);
  else if (step.type === 'F') renderWrite(step);
  else renderQuestion(step);
}

function quitRound() {
  const answered = session.results.length;
  if (answered > 0 && !session.done && !confirm('結束這回合？已作答的進度都已儲存。')) return;
  const home = session.home;
  session = null;
  go(home);
}

function nextStep() {
  session.advance();
  if (session.done) finishRound();
  renderPractice();
}

function introCard(item) {
  const reading = srs.hasReading(item);
  return el('div', {},
    el('div', { class: 'board' }, boardChar(item.kana)),
    el('p', { class: reading ? 'intro-romaji' : 'intro-romaji intro-kind' },
      item.romaji, reading ? speakerButton(item.kana) : null),
    reading && write.hasStrokeData(item.kana)
      ? el('p', { class: 'intro-strokes' },
        el('button', { class: 'btn btn-small', type: 'button', onclick: () => showStrokeCard(item) }, '看筆順'))
      : null,
    item.note ? el('p', { class: 'intro-note' }, item.note) : null,
    item.confusables?.length
      ? el('div', { class: 'confusables' },
        el('h3', {}, '別和這些字搞混'),
        el('ul', {}, item.confusables.map((c) =>
          el('li', {}, el('span', { class: 'k', lang: 'ja' }, c.kana), el('span', { class: 'r' }, c.romaji)))),
      )
      : null,
  );
}

function renderIntro(step) {
  const item = index.byId.get(step.id);
  const day = srs.today();
  if (!session.introduced.has(item.id)) {
    session.introduced.add(item.id);
    dayLog(day).newItems += 1;
    // 促音、長音沒有認讀題，看過說明卡就算學過
    if (!srs.hasReading(item)) state.items[item.id] = { ...state.items[item.id], seen: day };
    persist();
  }

  const btn = el('button', { class: 'btn btn-primary btn-big', onclick: nextStep }, '記住了');
  mount(el('p', { class: 'intro-label' }, srs.hasReading(item) ? '新字' : '特殊符號'), introCard(item), btn);
  btn.focus();
  if (srs.hasReading(item)) say(item.kana);
  keyHandler = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextStep(); }
    else if (e.key === ' ' && srs.hasReading(item)) { e.preventDefault(); say(item.kana); }
  };
}

// 答錯時把正解與你選的字並排放大
function compareBlock(right, wrong) {
  const cell = (label, entry, cls) => el('div', { class: `compare-cell ${cls}` },
    el('span', { class: 'compare-label' }, label),
    entry.kana ? el('span', { class: 'compare-kana', lang: 'ja' }, entry.kana) : null,
    el('span', { class: 'compare-romaji' }, entry.romaji || '（空白）'));
  return el('div', { class: 'compare' },
    cell('正解', right, 'is-right'),
    wrong ? cell(wrong.typed ? '你輸入' : '你選的', wrong, 'is-wrong') : null);
}

function renderQuestion(step) {
  const item = index.byId.get(step.id);
  const target = quiz.targetOf(item, step.type, index);
  const listening = step.type === 'C';

  let boardContent;
  if (step.type === 'B') boardContent = boardChar(item.romaji, { romaji: true });
  else if (listening) boardContent = speakerButton(item.kana, { big: true });
  else boardContent = boardChar(item.kana);
  const board = el('div', { class: 'board' }, boardContent);

  mount(el('p', { class: 'prompt' }, PROMPTS[step.type](item)), board);

  let startedAt = null;
  let answered = false;
  const feedbackSlot = el('div');

  function settle({ correct, picked, typed }) {
    if (answered) return;
    answered = true;
    // 聽音題在語音播完前就作答，視為反應時間 0
    const ms = startedAt == null ? (listening ? 0 : null) : performance.now() - startedAt;
    const day = srs.today();
    const kind = step.type === 'E' ? 'typing' : 'choice';
    const fast = correct && srs.isFast(ms, kind);

    const prog = (state.items[item.id] ||= {});
    const wasNew = (prog.read?.level ?? 0) === 0;
    const { track, leveledUp } = srs.applyAnswer(prog.read, { correct, fast, ms }, day);
    prog.read = track;
    // 誤選紀錄記在「正解那個字」上：D 題是對應的另一種假名
    if (!correct && picked?.id && picked.id !== target.id) {
      const tp = (state.items[target.id] ||= {});
      tp.wrongWith ||= {};
      tp.wrongWith[picked.id] = (tp.wrongWith[picked.id] || 0) + 1;
    }
    // 新字從 0 進到 1 級不算「升級」，回合結束頁只列複習中真正升級的字
    if (leveledUp && !wasNew) session.leveledUp.push(item.id);

    const log = dayLog(day);
    log.q += 1;
    if (correct) log.correct += 1;
    if (ms != null) log.ms += Math.round(ms);
    session.record({ id: item.id, type: step.type, correct, ms, picked: picked?.label ?? typed });
    persist();

    if (listening) board.replaceChildren(boardChar(item.kana));

    if (correct) {
      board.append(maruSvg());
      setTimeout(nextStep, CORRECT_PAUSE_MS);
      keyHandler = null;
    } else {
      showWrong({ picked, typed });
    }
  }

  function showWrong({ picked, typed }) {
    const next = el('button', { class: 'btn btn-primary', onclick: nextStep }, '下一題');
    let wrong = null;
    if (picked) wrong = picked;
    else if (typed != null) {
      // 打的拼音剛好是另一個字的讀音時，一起顯示那個字
      const v = quiz.normalizeRomaji(typed);
      const match = data.items.find((it) => it.script === item.script && it.type === item.type
        && it.accept.some((a) => quiz.normalizeRomaji(a) === v));
      wrong = { typed: true, kana: match?.kana, romaji: typed };
    }
    const extraAccept = target.accept.filter((a) => a !== target.romaji);
    feedbackSlot.append(el('div', { class: 'feedback' },
      compareBlock(target, wrong),
      extraAccept.length && step.type === 'E' ? el('p', { class: 'note' }, `也接受：${extraAccept.join('、')}`) : null,
      target.note ? el('p', { class: 'note' }, target.note) : null,
      next,
    ));
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    say(target.kana);
    keyHandler = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nextStep(); }
      else if (e.key === ' ') { e.preventDefault(); say(target.kana); }
    };
  }

  if (step.type === 'E') {
    const input = el('input', {
      class: 'text-input',
      type: 'text',
      inputmode: 'text',
      enterkeyhint: 'done',
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': '羅馬拼音',
      placeholder: '例如 ka',
    });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, '確定');
    const form = el('form', {
      class: 'type-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (answered) return;
        const typed = input.value;
        if (quiz.normalizeRomaji(typed) === '') return;
        const correct = quiz.checkTyped(item, typed);
        input.disabled = true;
        submit.disabled = true;
        input.classList.add(correct ? 'is-right' : 'is-wrong');
        settle({ correct, typed: typed.trim() });
      },
    }, input, submit);
    mount(form, feedbackSlot);
    input.focus();
  } else {
    const { options } = quiz.buildChoices(item, step.type, { data, index, state, prefer: step.prefer });
    const buttons = options.map((opt, i) => el('button', {
      class: 'option',
      lang: step.type === 'A' ? 'en' : 'ja',
      onclick: () => choose(i),
    }, el('span', { class: 'key', 'aria-hidden': 'true' }, i + 1), opt.label));

    function choose(i) {
      if (answered) return;
      const opt = options[i];
      buttons.forEach((b) => { b.disabled = true; });
      if (opt.correct) {
        buttons[i].classList.add('is-picked-right');
      } else {
        buttons[i].classList.add('is-wrong');
        buttons[options.findIndex((o) => o.correct)].classList.add('is-answer');
      }
      settle({ correct: opt.correct, picked: opt });
    }

    mount(el('div', { class: 'options' }, buttons), feedbackSlot);
    keyHandler = (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) { e.preventDefault(); choose(n - 1); }
      else if (e.key === ' ' && listening) { e.preventDefault(); say(item.kana); }
    };
  }

  if (listening) {
    // 聽音題的反應時間從語音播完起算
    say(item.kana).then(() => { if (!answered) startedAt = performance.now(); });
    return;
  }

  // 反應時間從題目完整畫出來起算。先記下現在的時間，避免分頁在背景時 requestAnimationFrame 不觸發。
  startedAt = performance.now();
  const begin = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!answered) startedAt = performance.now();
  }));
  if (document.fonts?.status === 'loading') document.fonts.ready.then(begin);
  else begin();
}

// ---------- 書寫題（F） ----------

// 範字（Klee One）＋筆順動畫並排；拗音只有範字
function modelBlock(item) {
  const model = el('div', { class: 'board board-small' }, boardChar(item.kana));
  const cells = [el('figure', { class: 'model-cell' }, model, el('figcaption', {}, '範字'))];
  if (write.hasStrokeData(item.kana)) {
    const box = el('div', { class: 'board board-small stroke-box' });
    const replay = el('button', { class: 'btn btn-small', type: 'button', disabled: true }, '重播筆順');
    cells.push(el('figure', { class: 'model-cell' }, box, el('figcaption', {}, replay)));
    write.loadStrokes(item.kana).then((strokes) => {
      const anim = write.strokeAnimation(strokes);
      box.append(anim);
      replay.disabled = false;
      replay.addEventListener('click', () => anim.replay());
      box.addEventListener('click', () => anim.replay());
    }).catch(() => {
      box.append(el('span', { class: 'stroke-missing' }, '筆順載入失敗'));
    });
  }
  return { node: el('div', { class: 'model-row' }, cells), model };
}

function renderWrite(step) {
  const item = index.byId.get(step.id);
  const yoon = !write.hasStrokeData(item.kana);
  document.documentElement.classList.add('no-overscroll');

  let mode = state.settings.writeMode === 'screen' ? 'screen' : 'paper';
  let pad = null;
  let revealed = false;
  let graded = false;

  const MODES = [['paper', '紙筆'], ['screen', '螢幕手寫']];
  const modeButtons = MODES.map(([m, label]) => el('button', {
    class: 'seg-btn',
    type: 'button',
    'aria-pressed': String(m === mode),
    onclick: () => {
      if (m === mode) return;
      mode = m;
      state.settings.writeMode = m;
      persist();
      modeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(MODES[i][0] === mode)));
      drawArea();
    },
  }, label));
  const modeSwitch = el('div', { class: 'seg', role: 'group', 'aria-label': '書寫方式' }, modeButtons);

  const area = el('div', { class: 'write-area' });
  const actions = el('div', { class: 'write-actions' });
  const reveal = el('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: showAnswer }, '對答案');

  mount(
    el('p', { class: 'prompt' }, PROMPTS.F(item), yoon ? '（注意小字的位置和大小）' : ''),
    el('div', { class: 'write-cue' },
      el('span', { class: 'write-romaji', lang: 'en' }, item.romaji),
      speakerButton(item.kana)),
    modeSwitch,
    area,
    actions,
  );

  function drawArea() {
    if (mode === 'paper') {
      pad = null;
      area.replaceChildren(el('p', { class: 'paper-note' }, '在紙上寫完，再按「對答案」。'));
      actions.replaceChildren(reveal);
      return;
    }
    const canvas = el('canvas', { class: 'pad', 'aria-label': '手寫區' });
    const wrap = el('div', { class: 'pad-wrap no-select' }, canvas);
    area.replaceChildren(wrap);
    pad = new write.WritingPad(canvas);
    const undo = el('button', { class: 'btn', type: 'button', disabled: true, onclick: () => pad.undo() }, '復原上一筆');
    const clear = el('button', { class: 'btn', type: 'button', disabled: true, onclick: () => pad.clear() }, '清除');
    pad.onChange((p) => { undo.disabled = p.isEmpty; clear.disabled = p.isEmpty; });
    actions.replaceChildren(el('div', { class: 'btn-row pad-tools' }, undo, clear), reveal);
  }

  function showAnswer() {
    if (revealed) return;
    revealed = true;
    modeSwitch.remove();

    // 螢幕手寫：範字以 30% 透明度疊在筆跡上方，方便比對位置與比例
    if (pad) {
      pad.canvas.parentNode.append(el('span', { class: 'pad-overlay', lang: 'ja', 'aria-hidden': 'true' }, item.kana));
    }
    const { node, model } = modelBlock(item);
    const buttons = WRITE_GRADES.map(([g, label, cls], i) => el('button', {
      class: cls,
      type: 'button',
      onclick: () => grade(g, model),
    }, el('span', { class: 'key', 'aria-hidden': 'true' }, i + 1), label));
    actions.replaceChildren(
      el('div', { class: 'write-answer no-select' }, node, item.note ? el('p', { class: 'note' }, item.note) : null),
      el('p', { class: 'grade-prompt' }, '和範字比一比，你寫得如何？'),
      el('div', { class: 'grade-buttons' }, buttons),
    );
    buttons[0].focus({ preventScroll: true });
    actions.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    keyHandler = (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= WRITE_GRADES.length) { e.preventDefault(); grade(WRITE_GRADES[n - 1][0], model); }
      else if (e.key === ' ') { e.preventDefault(); say(item.kana); }
    };
  }

  function grade(g, model) {
    if (graded) return;
    graded = true;
    keyHandler = null;
    actions.querySelectorAll('.grade-buttons button').forEach((b) => { b.disabled = true; });
    const day = srs.today();
    const correct = g !== 'wrong';
    const prog = (state.items[item.id] ||= {});
    const wasNew = (prog.write?.level ?? 0) === 0;
    const { track, leveledUp } = srs.applyWrite(prog.write, g, day);
    prog.write = track;
    if (leveledUp && !wasNew) session.leveledUp.push(item.id);

    const log = dayLog(day);
    log.q += 1;
    if (correct) log.correct += 1;
    session.record({ id: item.id, type: 'F', correct, ms: null, grade: g });
    persist();

    if (g === 'right') {
      model.append(maruSvg());
      setTimeout(nextStep, CORRECT_PAUSE_MS);
    } else {
      nextStep();
    }
  }

  drawArea();
  say(item.kana);
  keyHandler = (e) => {
    if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); showAnswer(); }
    else if (e.key === ' ') { e.preventDefault(); say(item.kana); }
  };
}

function showStrokeCard(item) {
  const dlg = document.getElementById('card-dialog');
  const { node } = modelBlock(item);
  document.getElementById('card-dialog-body').replaceChildren(
    el('p', { class: 'intro-romaji' }, item.romaji, speakerButton(item.kana)),
    el('div', { class: 'no-select' }, node),
  );
  if (!dlg.open) dlg.showModal();
}

// ---------- 書寫頁 ----------

function renderWritePage() {
  setPage('write');
  const day = srs.today();
  const open = srs.unlockedItems(data.items, state.unlocked).filter((it) => srs.writeOpen(it, state, day));
  const due = srs.dueWriteItems(data.items, state, day).length;

  const start = el('button', {
    class: 'btn btn-primary btn-big',
    disabled: !open.length,
    onclick: () => startRound('write'),
  }, due ? `開始書寫練習（${Math.min(due, quiz.WRITE_ROUND_SIZE)} 個字）` : '加練書寫');

  const isDakuon = (it) => it.type === 'dakuon' || it.type === 'handakuon';
  const groups = [
    ['平假名', (it) => it.script === 'hira' && it.type === 'seion'],
    ['片假名', (it) => it.script === 'kata' && it.type === 'seion'],
    ['平假名濁音・半濁音', (it) => it.script === 'hira' && isDakuon(it)],
    ['片假名濁音・半濁音', (it) => it.script === 'kata' && isDakuon(it)],
  ];
  const unlocked = new Set(state.unlocked);

  mount(
    el('header', { class: 'masthead' }, el('h1', {}, '書寫練習')),
    el('p', { class: 'muted' }, '看拼音、聽讀音，自己寫出假名，再對照範字和筆順自評。建議用紙筆寫，也可以直接在螢幕上寫。'),
    el('div', { class: 'tally tally-2' },
      el('div', {}, el('span', { class: 'num' }, open.length), el('span', { class: 'label' }, '可以寫的字')),
      el('div', {}, el('span', { class: 'num' }, due), el('span', { class: 'label' }, '今天要寫')),
    ),
    open.length ? null : el('p', { class: 'done-note' }, '學過的字隔天就會開放書寫，先去做今日練習吧。'),
    start,
    el('section', { class: 'section' },
      el('h2', {}, '筆順表'),
      el('p', { class: 'muted' }, '點字看筆順動畫。字下面的小點是書寫等級（0～5）。'),
      groups.map(([title, test]) => el('div', { class: 'unit-group' },
        el('h3', {}, title),
        el('div', { class: 'chips' },
          data.items.filter(test).map((it) => {
            const level = srs.writeLevel(state, it.id);
            return el('button', {
              class: unlocked.has(it.unit) ? 'chip' : 'chip chip-locked',
              lang: 'ja',
              onclick: () => showStrokeCard(it),
            }, it.kana, el('small', { class: 'wdots', 'aria-label': `書寫 ${level} 級` },
              [1, 2, 3, 4, 5].map((n) => el('i', { class: n <= level ? 'on' : '' }))));
          })),
      )),
    ),
  );
}

function finishRound() {
  const day = srs.today();
  dayLog(day).rounds += 1;
  session.unlockedUnits = srs.autoUnlock(data, state);
  persist();
}

function renderSummary() {
  const s = session.summary();
  const chipFor = (id) => {
    const item = index.byId.get(id);
    return el('button', { class: 'chip', lang: 'ja', onclick: () => showCard(item) },
      item.kana, el('small', {}, item.romaji));
  };

  const wordChip = (id) => {
    const w = wordIndex.get(id);
    return el('button', { class: 'chip chip-word', lang: 'ja', onclick: () => showWordCard(w) },
      w.word, el('small', {}, w.meaning));
  };

  const back = session.home;
  const backLabels = { write: '回到書寫練習', words: '回到單字閱讀', stats: '回到統計' };
  const home = el('button', { class: 'btn btn-primary', onclick: () => { session = null; go(back); } },
    backLabels[back] || '回到首頁');
  const wrongCount = s.wrong.length + s.wrongWords.length;

  mount(
    el('div', { class: 'result-head' },
      el('h1', {}, '這回合結束了'),
      el('p', { class: 'muted' },
        s.total ? `正確率 ${Math.round(s.accuracy * 100)}%（${s.correct} / ${s.total}）` : '',
        s.avgMs != null ? `・平均 ${(s.avgMs / 1000).toFixed(1)} 秒` : ''),
    ),
    s.unlockedUnits.length
      ? el('p', { class: 'unlock-banner', lang: 'ja' }, `解鎖了：${s.unlockedUnits.map(unitLabel).join('、')}`)
      : null,
    // 只有單字題的回合（單字閱讀）沒有等級可升，不顯示這一段
    session.results.some((r) => !r.word)
      ? el('section', { class: 'section' },
        el('h2', {}, `升級的字（${s.leveledUp.length}）`),
        s.leveledUp.length ? el('div', { class: 'chips' }, s.leveledUp.map(chipFor)) : el('p', { class: 'muted' }, '這回合沒有升級的字。答得又快又對才會升級。'),
      )
      : null,
    el('section', { class: 'section' },
      el('h2', {}, `答錯的${s.wrongWords.length ? '字和單字' : '字'}（${wrongCount}）`),
      wrongCount
        ? el('div', {}, el('p', { class: 'muted' }, '點字可以再看一次認識卡。'),
          el('div', { class: 'chips' }, s.wrong.map(chipFor), s.wrongWords.map(wordChip)))
        : el('p', { class: 'muted' }, '全部答對！'),
    ),
    el('div', { class: 'section btn-row' }, home),
  );
  home.focus();
  keyHandler = (e) => {
    if (e.key === 'Enter' && !document.getElementById('card-dialog').open) { e.preventDefault(); home.click(); }
  };
}

function showCard(item) {
  const dlg = document.getElementById('card-dialog');
  document.getElementById('card-dialog-body').replaceChildren(introCard(item));
  dlg.showModal();
}

// ---------- 單字題（G） ----------

// 單字依字數縮小字級，一行放得下
function wordText(text, cls = 'word-text') {
  const n = Math.max([...text].length, 2);
  return el('span', { class: cls, lang: 'ja', style: `--n:${n}` }, text);
}

function wordAnswerLine(word) {
  return el('p', { class: 'word-answer' },
    el('span', { class: 'word-romaji', lang: 'en' }, word.romaji),
    el('span', { class: 'word-meaning' }, word.meaning),
    speakerButton(word.word));
}

function renderWordQuestion(step) {
  const word = wordIndex.get(step.id);
  const board = el('div', { class: 'word-board' }, wordText(word.word));
  const reveal = el('div', { class: 'word-reveal' });
  const feedbackSlot = el('div');
  let answered = false;

  mount(el('p', { class: 'prompt' }, WORD_PROMPTS[step.type]), board, reveal);

  function settle({ correct, picked, typed }) {
    if (answered) return;
    answered = true;
    keyHandler = null;
    const day = srs.today();
    state.words ||= {};
    const rec = (state.words[word.word] ||= { n: 0, ok: 0 });
    rec.n += 1;
    if (correct) rec.ok += 1;
    rec.last = day;
    // 答錯：把單字裡最弱的假名排進下一回合
    const focus = correct ? null : wq.addFocus(state, word, index);

    const log = dayLog(day);
    log.q += 1;
    if (correct) log.correct += 1;
    session.record({ id: word.word, word: true, type: step.type, correct, ms: null });
    persist();

    if (!reveal.hasChildNodes()) reveal.append(wordAnswerLine(word));
    if (correct) {
      board.append(maruSvg());
      // 唸讀自評已經聽過答案；選拼音、打字答對時再念一次，多看一下意思
      // 等待期間若已離開這一題（結束回合），就不再前進
      const proceed = () => { if (session?.current === step) nextStep(); };
      if (step.type === 'S') setTimeout(proceed, CORRECT_PAUSE_MS);
      else say(word.word).then(() => setTimeout(proceed, CORRECT_PAUSE_MS));
      return;
    }
    if (step.type === 'S') {
      if (focus) toast(`「${index.byId.get(focus).kana}」會排進下一回合複習`);
      nextStep();
      return;
    }
    showWrong({ picked, typed, focus });
  }

  function showWrong({ picked, typed, focus }) {
    const next = el('button', { class: 'btn btn-primary', onclick: nextStep }, '下一題');
    const wrong = picked ? { kana: picked.kana, romaji: picked.romaji } : { typed: true, romaji: typed };
    feedbackSlot.append(el('div', { class: 'feedback' },
      el('div', { class: 'compare compare-words' },
        compareWordCell('正解', { kana: word.word, romaji: word.romaji }, 'is-right'),
        compareWordCell(wrong.typed ? '你輸入' : '你選的', wrong, 'is-wrong')),
      focus ? el('p', { class: 'note' }, `「${index.byId.get(focus).kana}」會排進下一回合複習。`) : null,
      next,
    ));
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    say(word.word);
    keyHandler = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nextStep(); }
      else if (e.key === ' ') { e.preventDefault(); say(word.word); }
    };
  }

  if (step.type === 'S') {
    const hasVoice = tts.getStatus() === 'ok';
    const actions = el('div', { class: 'word-actions' });
    const show = el('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: showAnswer },
      hasVoice ? '🔊 聽答案' : '看答案');
    actions.append(show);
    mount(actions, feedbackSlot);
    show.focus();

    function showAnswer() {
      if (reveal.hasChildNodes()) return;
      reveal.append(wordAnswerLine(word));
      say(word.word);
      const grades = [[true, '唸對了', 'btn btn-primary'], [false, '唸錯了', 'btn']].map(([ok, label, cls], i) =>
        el('button', { class: cls, type: 'button', onclick: () => settle({ correct: ok }) },
          el('span', { class: 'key', 'aria-hidden': 'true' }, i + 1), label));
      actions.replaceChildren(
        el('p', { class: 'grade-prompt' }, '和你唸的一樣嗎？'),
        el('div', { class: 'grade-buttons grade-2' }, grades),
      );
      grades[0].focus({ preventScroll: true });
      keyHandler = (e) => {
        if (e.key === '1') { e.preventDefault(); settle({ correct: true }); }
        else if (e.key === '2') { e.preventDefault(); settle({ correct: false }); }
        else if (e.key === ' ') { e.preventDefault(); say(word.word); }
      };
    }
    keyHandler = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAnswer(); }
    };
    return;
  }

  if (step.type === 'T') {
    const input = el('input', {
      class: 'text-input',
      type: 'text',
      inputmode: 'text',
      enterkeyhint: 'done',
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': '羅馬拼音',
      placeholder: '長音可打 ou、ō 或 oo',
    });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, '確定');
    const form = el('form', {
      class: 'type-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (answered || wq.normalizeWordRomaji(input.value) === '') return;
        const correct = wq.checkWordTyped(word, input.value);
        input.disabled = true;
        submit.disabled = true;
        input.classList.add(correct ? 'is-right' : 'is-wrong');
        settle({ correct, typed: input.value.trim() });
      },
    }, input, submit);
    mount(form, feedbackSlot);
    input.focus();
    return;
  }

  const { options } = wq.buildWordChoices(word, { data, index, state });
  const buttons = options.map((opt, i) => el('button', {
    class: 'option',
    lang: 'en',
    onclick: () => choose(i),
  }, el('span', { class: 'key', 'aria-hidden': 'true' }, i + 1), opt.label));

  function choose(i) {
    if (answered) return;
    const opt = options[i];
    buttons.forEach((b) => { b.disabled = true; });
    if (opt.correct) buttons[i].classList.add('is-picked-right');
    else {
      buttons[i].classList.add('is-wrong');
      buttons[options.findIndex((o) => o.correct)].classList.add('is-answer');
    }
    settle({ correct: opt.correct, picked: opt });
  }

  mount(el('div', { class: 'options' }, buttons), feedbackSlot);
  keyHandler = (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= options.length) { e.preventDefault(); choose(n - 1); }
  };
}

function compareWordCell(label, entry, cls) {
  return el('div', { class: `compare-cell ${cls}` },
    el('span', { class: 'compare-label' }, label),
    entry.kana ? wordText(entry.kana, 'compare-word') : null,
    el('span', { class: 'compare-romaji' }, entry.romaji || '（空白）'));
}

function showWordCard(word) {
  const dlg = document.getElementById('card-dialog');
  const rec = state.words?.[word.word];
  const kana = word.requires.map((id) => index.byId.get(id)).filter((it) => it && srs.hasReading(it));
  document.getElementById('card-dialog-body').replaceChildren(
    el('div', { class: 'word-board word-board-small' }, wordText(word.word)),
    wordAnswerLine(word),
    el('p', { class: 'muted center' }, rec ? `讀過 ${rec.n} 次，唸對 ${rec.ok} 次` : '還沒讀過'),
    kana.length
      ? el('div', { class: 'confusables' },
        el('h3', {}, '用到的假名'),
        el('ul', {}, kana.map((it) => el('li', {},
          el('span', { class: 'k', lang: 'ja' }, it.kana),
          el('span', { class: 'r' }, `${it.romaji}・${srs.readLevel(state, it.id)} 級`)))))
      : null,
  );
  if (!dlg.open) dlg.showModal();
}

// ---------- 單字頁 ----------

function renderWordsPage() {
  setPage('words');
  const avail = wq.availableWords(words, index, state);
  const enough = avail.length >= wq.MIN_WORDS;
  const read = avail.filter((w) => state.words?.[w.word]).length;

  const start = el('button', {
    class: 'btn btn-primary btn-big',
    disabled: !enough,
    onclick: () => startRound('words'),
  }, enough ? `開始讀單字（${Math.min(avail.length, wq.WORD_ROUND_SIZE)} 個）` : '解鎖更多假名後開放');

  let hint = null;
  if (!enough) {
    const rows = wq.rowsUntilWords(data, words, index, state);
    hint = el('p', { class: 'done-note' },
      rows ? `再解鎖 ${rows} 行就能開始讀單字。` : '目前解鎖的字還湊不到 5 個單字。');
  }

  mount(
    el('header', { class: 'masthead' }, el('h1', {}, '單字閱讀')),
    el('p', { class: 'muted' }, '用真實單字練「看到就讀得出來」。有時選拼音，有時自己唸出來再聽答案。促音（っ）和長音（ー）也在這裡練。單字只會用到你已經解鎖的假名。'),
    el('div', { class: 'tally tally-2' },
      el('div', {}, el('span', { class: 'num' }, avail.length), el('span', { class: 'label' }, '可以讀的單字'),
        el('span', { class: 'sub' }, `共 ${words.length} 個`)),
      el('div', {}, el('span', { class: 'num' }, read), el('span', { class: 'label' }, '讀過的單字')),
    ),
    hint,
    start,
    avail.length
      ? el('section', { class: 'section' },
        el('h2', {}, '單字表'),
        el('p', { class: 'muted' }, '點單字看拼音、意思和用到的假名。'),
        el('div', { class: 'chips' }, avail.map((w) => el('button', {
          class: 'chip chip-word',
          lang: 'ja',
          onclick: () => showWordCard(w),
        }, w.word, el('small', {}, w.meaning)))),
        avail.length < words.length
          ? el('p', { class: 'muted' }, `還有 ${words.length - avail.length} 個單字會在解鎖更多假名後出現。`)
          : null,
      )
      : null,
  );
  keyHandler = (e) => {
    if (e.key === 'Enter' && enough && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); start.click(); }
  };
}

// ---------- 統計頁 ----------

const STATS_TABS = [
  ['hira', '平假名', [['', (it) => it.script === 'hira' && it.type === 'seion']]],
  ['kata', '片假名', [['', (it) => it.script === 'kata' && it.type === 'seion']]],
  ['dakuon', '濁音', [
    ['平假名', (it) => it.script === 'hira' && (it.type === 'dakuon' || it.type === 'handakuon')],
    ['片假名', (it) => it.script === 'kata' && (it.type === 'dakuon' || it.type === 'handakuon')],
  ]],
  ['yoon', '拗音', [
    ['平假名', (it) => it.script === 'hira' && it.type === 'yoon'],
    ['片假名', (it) => it.script === 'kata' && it.type === 'yoon'],
  ]],
];
let statsTab = 'hira';
const CHART_DAYS = 30;

function renderStats() {
  setPage('stats');
  const learnable = data.items.filter(srs.hasReading);
  const learned = learnable.filter((it) => srs.readLevel(state, it.id) > 0).length;
  const remembered = learnable.filter((it) => srs.readLevel(state, it.id) >= srs.UNLOCK_LEVEL).length;
  const mastered = learnable.filter((it) => state.items[it.id]?.read?.mastered).length;

  const gridSlot = el('div');
  const tabs = STATS_TABS.map(([key, label]) => el('button', {
    class: 'seg-btn',
    type: 'button',
    'aria-pressed': String(key === statsTab),
    onclick: () => {
      statsTab = key;
      tabs.forEach((b, i) => b.setAttribute('aria-pressed', String(STATS_TABS[i][0] === statsTab)));
      drawGrid();
    },
  }, label));

  function drawGrid() {
    const [, , groups] = STATS_TABS.find(([key]) => key === statsTab);
    gridSlot.replaceChildren(...groups.map(([title, test]) => el('div', { class: 'unit-group' },
      title ? el('h3', {}, title) : null,
      kanaGrid(data.items.filter(test)))));
  }
  drawGrid();

  mount(
    el('header', { class: 'masthead' }, el('h1', {}, '統計')),
    el('div', { class: 'tally' },
      el('div', {}, el('span', { class: 'num' }, learned), el('span', { class: 'label' }, '學過的字')),
      el('div', {}, el('span', { class: 'num' }, remembered), el('span', { class: 'label' }, '記住'),
        el('span', { class: 'sub' }, '3 級以上')),
      el('div', {}, el('span', { class: 'num' }, mastered), el('span', { class: 'label' }, '精熟')),
    ),
    el('section', { class: 'section' },
      el('h2', {}, '50 音表'),
      el('div', { class: 'seg seg-4', role: 'group', 'aria-label': '切換字表' }, tabs),
      gridSlot,
      gridLegend(),
    ),
    confusionSection(),
    dailyChart(),
  );
}

// 傳統 50 音表排法：每列一行，欄是母音（拗音是 ya、yu、yo 三欄）；ん 自成一列
function kanaGrid(items) {
  const yoon = items[0]?.type === 'yoon';
  const cols = yoon ? 'auo' : 'aiueo';
  const rowKey = (it) => (it.id.endsWith('-n') ? 'n' : it.row);
  const rows = [...new Set(items.map(rowKey))];
  const unlocked = new Set(state.unlocked);
  const cells = [];
  for (const row of rows) {
    const inRow = items.filter((it) => rowKey(it) === row);
    for (const v of cols) {
      const it = row === 'n'
        ? (v === 'a' ? inRow[0] : null)
        : inRow.find((x) => x.id.split('-')[1].endsWith(v));
      cells.push(it ? gridCell(it, unlocked.has(it.unit)) : el('span', { class: 'cell cell-empty', 'aria-hidden': 'true' }));
    }
  }
  return el('div', { class: yoon ? 'kana-grid kana-grid-3' : 'kana-grid' }, cells);
}

function gridCell(item, isUnlocked) {
  const lv = srs.readLevel(state, item.id);
  const wl = srs.writeLevel(state, item.id);
  const cls = ['cell', `lv${lv}`];
  if (!isUnlocked) cls.push('is-locked');
  return el('button', {
    class: cls.join(' '),
    type: 'button',
    lang: 'ja',
    'aria-label': `${item.kana}（${item.romaji}）：認讀 ${lv} 級、書寫 ${wl} 級${isUnlocked ? '' : '，未解鎖'}`,
    onclick: () => showItemCard(item),
  }, el('span', { class: [...item.kana].length > 1 ? 'cell-k cell-k-long' : 'cell-k' }, item.kana),
  wl > 0 ? el('i', { class: `wdot w${wl}`, 'aria-hidden': 'true' }) : null);
}

function gridLegend() {
  return el('div', { class: 'grid-legend' },
    el('span', {}, '認讀等級'),
    el('span', { class: 'legend-steps', 'aria-hidden': 'true' },
      [0, 1, 2, 3, 4, 5].map((n) => el('span', { class: `cell lv${n}` }, n))),
    el('span', { class: 'legend-dot' }, el('span', { class: 'cell lv0' }, el('i', { class: 'wdot w3' })), '右下小點：書寫等級（越大越深越高）'),
  );
}

// 點格子：認識卡＋答題紀錄
function showItemCard(item) {
  const dlg = document.getElementById('card-dialog');
  const prog = state.items[item.id] || {};
  const read = prog.read;
  const write = prog.write;
  const wrongs = Object.entries(prog.wrongWith || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => [index.byId.get(id), n])
    .filter(([it]) => it);
  const unlocked = state.unlocked.includes(item.unit);

  const rows = [];
  if (!unlocked) rows.push(['狀態', '還沒解鎖']);
  else if (!srs.hasReading(item)) rows.push(['狀態', prog.seen ? `看過說明卡（${prog.seen}）` : '還沒看過說明卡']);
  else {
    rows.push(['認讀', read?.level ? `${read.level} 級${read.mastered ? '（精熟）' : ''}・下次 ${read.due}` : '還沒學過']);
    if (read?.n) rows.push(['答題', `${read.n} 次，答對 ${read.ok || 0} 次`]);
    if (read?.lastMs != null) rows.push(['上次反應', `${(read.lastMs / 1000).toFixed(1)} 秒`]);
    if (srs.canWrite(item)) {
      rows.push(['書寫', write?.level ? `${write.level} 級・下次 ${write.due}` : (srs.writeOpen(item, state, srs.today()) ? '已開放，還沒寫過' : '學過的隔天開放')]);
    }
  }

  document.getElementById('card-dialog-body').replaceChildren(
    introCard(item),
    el('dl', { class: 'record' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    wrongs.length
      ? el('p', { class: 'record-wrong' }, '常誤選成：', wrongs.flatMap(([it, n], i) => [
        i ? '、' : '', el('span', { lang: 'ja' }, it.kana), ` ${n} 次`]))
      : null,
  );
  if (!dlg.open) dlg.showModal();
}

function confusionSection() {
  const top = wq.topConfusions(state, index);
  const kana = (id) => el('span', { class: 'conf-k', lang: 'ja' }, index.byId.get(id).kana);
  return el('section', { class: 'section' },
    el('h2', {}, '最常混淆的字組'),
    top.length
      ? el('div', {},
        el('p', { class: 'muted' }, '點一組開始「混淆專練」：10 題，只在這兩三個字之間出題。'),
        el('ol', { class: 'conf-list' }, top.map(({ id, other, count }) => el('li', {},
          el('button', {
            class: 'conf-btn',
            type: 'button',
            onclick: () => startRound('drill', wq.drillSet(state, index, id, other)),
          },
          kana(id), el('span', { class: 'conf-arrow' }, '→ 誤選'), kana(other),
          el('span', { class: 'conf-count' }, `${count} 次`),
          el('span', { class: 'conf-go' }, '專練')))))
      )
      : el('p', { class: 'muted' }, '還沒有選錯的紀錄。答錯時選到的字會記在這裡。'),
  );
}

// 近 30 天每日練習量：單一數列的長條圖，點或滑過長條顯示當天題數
function dailyChart() {
  const day = srs.today();
  const days = Array.from({ length: CHART_DAYS }, (_, i) => srs.addDays(day, i - CHART_DAYS + 1));
  const counts = days.map((d) => state.log[d]?.q ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  const active = counts.filter((n) => n > 0).length;
  const max = Math.max(...counts, 1);
  // 刻度取整到 10 的倍數
  const top = Math.max(10, Math.ceil(max / 10) * 10);
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

  const tip = el('div', { class: 'chart-tip', role: 'status', hidden: true });
  const showTip = (i, bar) => {
    const log = state.log[days[i]];
    tip.textContent = counts[i]
      ? `${md(days[i])}：${counts[i]} 題，答對 ${log?.correct ?? 0} 題`
      : `${md(days[i])}：沒有練習`;
    tip.hidden = false;
    const box = bar.parentNode.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    // 提示框不超出圖表左右邊界
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(r.left - box.left + r.width / 2, half), box.width - half)}px`;
  };
  const hideTip = () => { tip.hidden = true; };

  const bars = days.map((d, i) => {
    const bar = el('button', {
      class: counts[i] ? 'bar' : 'bar bar-zero',
      type: 'button',
      style: `--h:${(counts[i] / top) * 100}%`,
      'aria-label': `${md(d)} ${counts[i]} 題`,
      onpointerenter: (e) => showTip(i, e.currentTarget),
      onpointerleave: hideTip,
      onfocus: (e) => showTip(i, e.currentTarget),
      onblur: hideTip,
      onclick: (e) => showTip(i, e.currentTarget),
    });
    return bar;
  });

  return el('section', { class: 'section' },
    el('h2', {}, '每日練習量（近 30 天）'),
    el('p', { class: 'muted' }, total ? `共 ${total} 題，練習了 ${active} 天。` : '還沒有練習紀錄。'),
    el('div', { class: 'chart' },
      el('div', { class: 'chart-y', 'aria-hidden': 'true' }, el('span', {}, top), el('span', {}, top / 2), el('span', {}, 0)),
      el('div', { class: 'chart-plot' },
        el('div', { class: 'chart-grid', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
        el('div', { class: 'chart-bars' }, bars),
        tip),
      el('div', { class: 'chart-x', 'aria-hidden': 'true' },
        el('span', {}, md(days[0])), el('span', {}, md(days[14])), el('span', {}, '今天')),
    ),
  );
}

// ---------- 備份 ----------

function exportProgress() {
  const day = srs.today();
  state.backup = { ...state.backup, lastExport: day };
  persist();
  const payload = { app: 'kana-quiz', version: 1, exportedAt: new Date().toISOString(), state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `kana-quiz-backup-${day}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已匯出備份');
}

async function importProgress(file) {
  let incoming;
  try {
    const obj = JSON.parse(await file.text());
    incoming = obj?.app === 'kana-quiz' ? obj.state : obj;
    if (!incoming || typeof incoming.items !== 'object' || !Array.isArray(incoming.unlocked)) throw new Error('format');
  } catch {
    alert('這個檔案不是 50 音練習帖的備份檔。');
    return;
  }
  if (!confirm('匯入會覆蓋目前這個瀏覽器裡的進度，確定要匯入嗎？')) return;
  store.saveState(incoming);
  state = store.loadState([data.units[0].unit]);
  session = null;
  toast('已匯入進度');
  go('today');
}

// ---------- 設定 ----------

function renderSettings() {
  setPage('settings');
  const next = srs.nextUnitGroup(data.units, state.unlocked, { sync: state.settings.syncScripts });

  const saved = () => { persist(); toast('已儲存'); };

  const select = (key, values, label) => {
    const id = `set-${key}`;
    return el('div', { class: 'field' },
      el('label', { for: id }, label),
      el('select', {
        id,
        onchange: (e) => { state.settings[key] = Number(e.target.value); saved(); },
      }, values.map((v) => el('option', { value: v, selected: state.settings[key] === v }, v))),
    );
  };

  const rateValue = el('output', { for: 'set-rate' }, state.settings.ttsRate.toFixed(1));

  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) importProgress(f);
    },
  });

  const confirmBox = el('div', { class: 'confirm', hidden: true },
    el('p', {}, '確定要重設？所有進度都會刪除，無法復原。'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', onclick: () => { confirmBox.hidden = true; } }, '取消'),
      el('button', {
        class: 'btn btn-danger',
        onclick: () => {
          if (!confirm('最後確認：真的要刪除所有進度嗎？')) return;
          store.clearAll();
          state = store.loadState([data.units[0].unit]);
          session = null;
          toast('已重設所有進度');
          go('today');
        },
      }, '確定重設'),
    ),
  );

  mount(
    el('header', { class: 'masthead' }, el('h1', {}, '設定')),
    el('section', { class: 'section' },
      el('h2', {}, '練習量'),
      select('newPerDay', [3, 5, 8, 10], '每日新字上限'),
      select('roundSize', [20, 30, 50], '每回合題數'),
    ),
    el('section', { class: 'section' },
      el('h2', {}, '解鎖'),
      el('div', { class: 'field' },
        el('label', { for: 'set-sync' }, '平假名、片假名同步學',
          el('small', { class: 'muted field-hint' }, '同一行的平假名和片假名一起解鎖')),
        el('input', {
          id: 'set-sync',
          type: 'checkbox',
          class: 'switch',
          checked: state.settings.syncScripts,
          onchange: (e) => { state.settings.syncScripts = e.target.checked; saved(); renderSettings(); },
        }),
      ),
      el('p', { class: 'muted' }, '每個字要在不同天答對幾次（大約 3 天）才算記住；目前這些字全部記住後，就會自動開放下一行。以前已經學過的話，可以直接手動解鎖。'),
      el('button', {
        class: 'btn',
        disabled: !next,
        onclick: () => {
          const got = srs.manualUnlock(data, state);
          persist();
          toast(`解鎖了：${got.map(unitLabel).join('、')}`);
          renderSettings();
        },
      }, next ? `手動解鎖下一單位（${next.map(unitLabel).join('、')}）` : '所有單位都已解鎖'),
    ),
    el('section', { class: 'section' },
      el('h2', {}, '語音'),
      el('div', { class: 'field' },
        el('label', { for: 'set-rate' }, '語速 ', rateValue),
        el('input', {
          id: 'set-rate',
          type: 'range',
          min: '0.6',
          max: '1',
          step: '0.1',
          value: String(state.settings.ttsRate),
          oninput: (e) => { rateValue.textContent = Number(e.target.value).toFixed(1); },
          onchange: (e) => { state.settings.ttsRate = Number(e.target.value); saved(); },
        }),
      ),
      ttsStatusBlock(),
    ),
    el('section', { class: 'section danger-zone' },
      el('h2', {}, '資料備份'),
      el('p', { class: 'muted' },
        '進度只存在這個瀏覽器，換手機或清除瀏覽資料就會消失。匯出的檔案可以在另一支手機或電腦匯入。',
        state.backup?.lastExport ? `上次匯出：${state.backup.lastExport}。` : ''),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', onclick: exportProgress }, '匯出進度'),
        el('button', { class: 'btn', onclick: () => fileInput.click() }, '匯入進度'),
      ),
      fileInput,
      el('div', { class: 'section' },
        el('button', { class: 'btn', onclick: () => { confirmBox.hidden = false; } }, '重設所有進度'),
        confirmBox,
      ),
    ),
  );
}

function ttsStatusBlock() {
  const box = el('div', { class: 'tts-status' });
  const draw = () => {
    const status = tts.getStatus();
    box.replaceChildren(...[
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn',
          onclick: () => { tts.unlock(); tts.speak('あいうえお', { rate: state.settings.ttsRate }); },
        }, '🔊 測試語音（あいうえお）'),
      ),
      status === 'unknown' ? el('p', { class: 'muted' }, '正在檢查日語語音…') : null,
      status === 'ok' ? el('p', { class: 'muted' }, `已找到日語語音：${tts.voiceName()}`) : null,
      status === 'none' || status === 'unsupported'
        ? el('div', { class: 'notice' },
          el('p', {}, status === 'unsupported'
            ? '這個瀏覽器不支援語音功能，「聽音選假名」題型已暫停。'
            : '這個裝置沒有日語語音，「聽音選假名」題型已暫停。安裝日語語音後重新整理頁面即可恢復：'),
          el('ul', { class: 'help-list' },
            el('li', {}, el('strong', {}, 'Android：'), '「設定 > 一般管理（或系統）> 文字轉語音輸出」，偏好引擎選「Google 文字轉語音」，再到引擎設定裡下載日語語音資料。部分 Samsung 手機預設的 Samsung 引擎沒有日語。'),
            el('li', {}, el('strong', {}, 'Windows：'), '「設定 > 時間與語言 > 語言」加入日文，並安裝語音套件。'),
            el('li', {}, el('strong', {}, 'iPhone／iPad：'), '通常內建；若沒有聲音，到「設定 > 輔助使用 > 朗讀內容 > 聲音」下載日文語音。'),
          ),
        )
        : null,
    ].filter(Boolean));
  };
  draw();
  const off = tts.onStatusChange(() => {
    if (!box.isConnected) { off(); return; }
    draw();
  });
  return box;
}

// ---------- 啟動 ----------

async function init() {
  try {
    const res = await fetch('data/kana-data.json');
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch (err) {
    view.replaceChildren(el('p', {}, '資料載入失敗。如果是直接雙擊開啟 index.html，請改用本機伺服器（見 README）。'));
    console.error(err);
    return;
  }
  // 單字資料載入失敗時只影響單字題，其他功能照常
  try {
    const res = await fetch('data/words.json');
    if (!res.ok) throw new Error(res.status);
    words = (await res.json()).words || [];
  } catch (err) {
    console.error(err);
  }
  wordIndex = new Map(words.map((w) => [w.word, w]));
  index = quiz.indexData(data);
  state = store.loadState([data.units[0].unit]);
  tts.ready();
  window.addEventListener('hashchange', route);
  route();
}

init();

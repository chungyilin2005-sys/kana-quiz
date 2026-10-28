// 路由與畫面。畫面用 hash 切換：#today、#practice、#settings（#write、#words、#stats 之後的階段加入）。

import * as store from './storage.js';
import * as srs from './srs.js';
import * as quiz from './quiz.js';

// 階段一只開放平假名清音；之後的階段放寬這個條件
const isEnabledUnit = (u) => !!u && u.script === 'hira' && u.type === 'seion';
const ENABLED_TYPES = ['A', 'B', 'E'];

const CORRECT_PAUSE_MS = 600;
const WEEKDAYS = '日一二三四五六';

const PROMPTS = {
  A: '這個字怎麼念？',
  B: (item) => `選出這個讀音的${item.script === 'hira' ? '平假名' : '片假名'}`,
  E: '輸入羅馬拼音',
};

let data;
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

function unitLabel(name) {
  const u = data.units.find((x) => x.unit === name);
  if (!u) return name;
  const script = u.script === 'hira' ? '平假名' : u.script === 'kata' ? '片假名' : '';
  if (u.type === 'seion') return `${data.items.find((it) => it.unit === name).kana}行`;
  if (u.type.startsWith('dakuon')) return `${script}濁音・半濁音`;
  if (u.type === 'yoon') return `${script}拗音`;
  return '特殊符號';
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

// ---------- 路由 ----------

function route() {
  const name = (location.hash || '#today').slice(1);
  if (name === 'practice') return session ? renderPractice() : go('today');
  if (name === 'settings') return renderSettings();
  if (['write', 'words', 'stats'].includes(name)) return renderComingSoon(name);
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

  const unlocked = srs.autoUnlock(data, state, { enabled: isEnabledUnit });
  if (unlocked.length) {
    persist();
    toast(`解鎖了：${unlocked.map(unitLabel).join('、')}`);
  }

  const due = srs.dueReadItems(data.items, state, day).length;
  const newAvail = srs.newItemsAvailable(data.items, state).length;
  const newToday = Math.min(srs.newQuotaLeft(state, day), newAvail);
  const streak = srs.streakDays(state, day);
  const hasWork = due > 0 || newToday > 0;

  const [y, m, d] = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];

  const start = el('button', {
    class: 'btn btn-primary btn-big',
    onclick: () => startRound(!hasWork),
  }, hasWork ? '開始今日練習' : '加練一回合');

  const learned = data.items.some((it) => srs.readLevel(state, it.id) > 0);

  mount(
    el('header', { class: 'masthead' },
      el('h1', {}, '50音練習帖'),
      el('p', { class: 'date' }, `${m}月${d}日（${weekday}）`),
    ),
    el('div', { class: 'tally' },
      el('div', {},
        el('span', { class: 'num' }, due),
        el('span', { class: 'label' }, '待複習'),
        el('span', { class: 'sub' }, '認讀 ', due, '・書寫 0'),
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
    if (e.key === 'Enter') { e.preventDefault(); start.click(); }
  };
}

function progressSection() {
  const enabledUnits = data.units.filter(isEnabledUnit);
  const have = new Set(state.unlocked);
  const next = srs.nextUnitGroup(data.units, state.unlocked, { sync: state.settings.syncScripts, enabled: isEnabledUnit });
  const pool = srs.unlockedItems(data.items, state.unlocked);
  const ready = pool.filter((it) => srs.readLevel(state, it.id) >= srs.UNLOCK_LEVEL).length;
  const below = pool.length - ready;

  return el('section', { class: 'section' },
    el('h2', {}, '學習進度'),
    el('ul', { class: 'unit-list', lang: 'ja' },
      enabledUnits.map((u) => el('li', { class: have.has(u.unit) ? '' : 'locked' }, unitLabel(u.unit))),
    ),
    next
      ? el('div', {},
        el('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': pool.length, 'aria-valuenow': ready },
          el('span', { style: `width:${pool.length ? (ready / pool.length) * 100 : 0}%` })),
        el('p', { class: 'muted' },
          `下一個解鎖：${next.map(unitLabel).join('、')}。已解鎖的字全部達到 3 級就會開放，還差 ${below} 個字。`),
      )
      : el('p', { class: 'muted' }, '平假名清音都解鎖了。片假名、濁音、拗音會在下一個版本開放。'),
  );
}

// ---------- 練習回合 ----------

function startRound(extra) {
  const day = srs.today();
  const round = extra
    ? quiz.buildExtraRound(data, state, { enabledTypes: ENABLED_TYPES })
    : quiz.buildRound(data, state, day, { enabledTypes: ENABLED_TYPES });

  if (!round.steps.length) {
    toast('目前沒有可以練習的字');
    return;
  }
  session = new quiz.Session(round.steps, { extra });
  session.introduced = new Set();
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
      el('div', { class: 'meter' }, el('span', { style: `width:${((num - 1) / total) * 100}%` })),
      el('span', { class: 'progress-text' }, `${Math.min(num, total)} / ${total}`),
    ),
  );

  if (step.kind === 'intro') renderIntro(step);
  else renderQuestion(step);
}

function quitRound() {
  const answered = session.results.length;
  if (answered > 0 && !session.done && !confirm('結束這回合？已作答的進度都已儲存。')) return;
  session = null;
  go('today');
}

function nextStep() {
  session.advance();
  if (session.done) finishRound();
  renderPractice();
}

function introCard(item) {
  return el('div', {},
    el('div', { class: 'board' }, boardChar(item.kana)),
    el('p', { class: 'intro-romaji' }, item.romaji),
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
  if (!session.introduced.has(item.id)) {
    session.introduced.add(item.id);
    dayLog(srs.today()).newItems += 1;
    persist();
  }

  const btn = el('button', { class: 'btn btn-primary btn-big', onclick: nextStep }, '記住了');
  mount(el('p', { class: 'intro-label' }, '新字'), introCard(item), btn);
  btn.focus();
  keyHandler = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextStep(); }
  };
}

function renderQuestion(step) {
  const item = index.byId.get(step.id);
  const prompt = typeof PROMPTS[step.type] === 'function' ? PROMPTS[step.type](item) : PROMPTS[step.type];
  const board = el('div', { class: 'board' },
    step.type === 'B' ? boardChar(item.romaji, { romaji: true }) : boardChar(item.kana));

  mount(el('p', { class: 'prompt' }, prompt), board);

  let startedAt = null;
  let answered = false;
  const feedbackSlot = el('div');

  function settle({ correct, picked, typed }) {
    if (answered) return;
    answered = true;
    const ms = startedAt == null ? null : performance.now() - startedAt;
    const day = srs.today();
    const kind = step.type === 'E' ? 'typing' : 'choice';
    const fast = correct && srs.isFast(ms, kind);

    const prog = (state.items[item.id] ||= {});
    const wasNew = (prog.read?.level ?? 0) === 0;
    const { track, leveledUp } = srs.applyAnswer(prog.read, { correct, fast, ms }, day);
    prog.read = track;
    if (!correct && picked?.id && picked.id !== item.id) {
      prog.wrongWith ||= {};
      prog.wrongWith[picked.id] = (prog.wrongWith[picked.id] || 0) + 1;
    }
    // 新字從 0 進到 1 級不算「升級」，回合結束頁只列複習中真正升級的字
    if (leveledUp && !wasNew) session.leveledUp.push(item.id);

    const log = dayLog(day);
    log.q += 1;
    if (correct) log.correct += 1;
    if (ms != null) log.ms += Math.round(ms);
    session.record({ id: item.id, type: step.type, correct, ms, picked: picked?.label ?? typed });
    persist();

    if (correct) {
      board.append(maruSvg());
      setTimeout(nextStep, CORRECT_PAUSE_MS);
      keyHandler = null;
    } else {
      showWrong({ picked, typed });
    }
  }

  function showWrong({ typed }) {
    const next = el('button', { class: 'btn btn-primary', onclick: nextStep }, '下一題');
    const extraAccept = item.accept.filter((a) => a !== item.romaji);
    feedbackSlot.append(el('div', { class: 'feedback' },
      typed != null ? el('p', { class: 'answer-line' }, '你輸入：', typed || '（空白）') : null,
      el('p', { class: 'answer-line' },
        '正解：', el('strong', { lang: 'ja' }, item.kana), '　', el('strong', {}, item.romaji),
        extraAccept.length ? el('span', { class: 'muted' }, `（也接受 ${extraAccept.join('、')}）`) : null),
      item.note ? el('p', { class: 'note' }, item.note) : null,
      next,
    ));
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    keyHandler = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nextStep(); }
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
    const { options } = quiz.buildChoices(item, step.type, { data, index, state });
    const buttons = options.map((opt, i) => el('button', {
      class: 'option',
      lang: step.type === 'B' ? 'ja' : 'en',
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
    };
  }

  // 反應時間從題目完整畫出來起算。先記下現在的時間，避免分頁在背景時 requestAnimationFrame 不觸發。
  startedAt = performance.now();
  const begin = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!answered) startedAt = performance.now();
  }));
  if (document.fonts?.status === 'loading') document.fonts.ready.then(begin);
  else begin();
}

function finishRound() {
  const day = srs.today();
  dayLog(day).rounds += 1;
  session.unlockedUnits = srs.autoUnlock(data, state, { enabled: isEnabledUnit });
  persist();
}

function renderSummary() {
  const s = session.summary();
  const chipFor = (id) => {
    const item = index.byId.get(id);
    return el('button', { class: 'chip', lang: 'ja', onclick: () => showCard(item) },
      item.kana, el('small', {}, item.romaji));
  };

  const home = el('button', { class: 'btn btn-primary', onclick: () => { session = null; go('today'); } }, '回到首頁');

  mount(
    el('div', { class: 'result-head' },
      el('h1', {}, '這回合結束了'),
      el('p', { class: 'muted' },
        `正確率 ${Math.round(s.accuracy * 100)}%（${s.correct} / ${s.total}）`,
        s.avgMs != null ? `・平均 ${(s.avgMs / 1000).toFixed(1)} 秒` : ''),
    ),
    s.unlockedUnits.length
      ? el('p', { class: 'unlock-banner', lang: 'ja' }, `解鎖了：${s.unlockedUnits.map(unitLabel).join('、')}`)
      : null,
    el('section', { class: 'section' },
      el('h2', {}, `升級的字（${s.leveledUp.length}）`),
      s.leveledUp.length ? el('div', { class: 'chips' }, s.leveledUp.map(chipFor)) : el('p', { class: 'muted' }, '這回合沒有升級的字。答得又快又對才會升級。'),
    ),
    el('section', { class: 'section' },
      el('h2', {}, `答錯的字（${s.wrong.length}）`),
      s.wrong.length
        ? el('div', {}, el('p', { class: 'muted' }, '點字可以再看一次認識卡。'), el('div', { class: 'chips' }, s.wrong.map(chipFor)))
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

// ---------- 設定 ----------

function renderSettings() {
  setPage('settings');
  const next = srs.nextUnitGroup(data.units, state.unlocked, { sync: state.settings.syncScripts, enabled: isEnabledUnit });

  const select = (key, values, label) => {
    const id = `set-${key}`;
    return el('div', { class: 'field' },
      el('label', { for: id }, label),
      el('select', {
        id,
        onchange: (e) => { state.settings[key] = Number(e.target.value); persist(); toast('已儲存'); },
      }, values.map((v) => el('option', { value: v, selected: state.settings[key] === v }, v))),
    );
  };

  const confirmBox = el('div', { class: 'confirm', hidden: true },
    el('p', {}, '確定要重設？所有進度都會刪除，無法復原。'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', onclick: () => { confirmBox.hidden = true; } }, '取消'),
      el('button', {
        class: 'btn',
        style: 'border-color:var(--shu);color:var(--shu)',
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
      el('p', { class: 'muted' }, '正常情況下，已解鎖的字全部達到 3 級才會開放下一行。已經學過的話，可以手動解鎖。'),
      el('button', {
        class: 'btn',
        disabled: !next,
        onclick: () => {
          const got = srs.manualUnlock(data, state, { enabled: isEnabledUnit });
          persist();
          toast(`解鎖了：${got.map(unitLabel).join('、')}`);
          renderSettings();
        },
      }, next ? `手動解鎖下一單位（${next.map(unitLabel).join('、')}）` : '目前開放的單位都已解鎖'),
    ),
    el('section', { class: 'section danger-zone' },
      el('h2', {}, '資料'),
      el('p', { class: 'muted' }, '進度只存在這個瀏覽器。匯出／匯入備份會在下一個版本加入。'),
      el('button', { class: 'btn', onclick: () => { confirmBox.hidden = false; } }, '重設所有進度'),
      confirmBox,
    ),
  );
}

function renderComingSoon(name) {
  setPage(name);
  const titles = { write: '書寫練習', words: '單字閱讀', stats: '統計' };
  mount(
    el('header', { class: 'masthead' }, el('h1', {}, titles[name])),
    el('p', { class: 'muted' }, '這個功能還在製作中。'),
    el('a', { class: 'btn', href: '#today' }, '回到首頁'),
  );
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
  index = quiz.indexData(data);
  state = store.loadState([data.units[0].unit]);
  window.addEventListener('hashchange', route);
  route();
}

init();

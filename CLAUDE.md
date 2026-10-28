# kana-quiz 開發說明

50 音刷題網站。完整需求在 [SPEC.md](SPEC.md)，依「開發階段」逐段實作；每完成一個階段就停下來，讓使用者在手機上實測後再進下一階段。

## 目前進度

- 階段一、二已完成並上線：<https://chungyilin2005-sys.github.io/kana-quiz/>
- 下一步：階段三（書寫模式、KanjiVG 筆順、write 軌排進今日練習）
- repo：<https://github.com/chungyilin2005-sys/kana-quiz>，部署方式為 GitHub Pages（main 分支、根目錄）

## 工作流程

- 每個階段完成後：跑測試 → commit → push 到 `main` → 等 Pages 更新（約 1 分鐘，可用 `curl` 檢查線上檔案是否已是新版）。
- commit 作者已在本 repo 的 git config 設為 GitHub noreply 地址；不要改成私人 Email（帳號開了 Email 隱私保護，push 會被擋）。
- 本機預覽：`.claude/launch.json` 的 `kana-quiz`（`python -m http.server 8000`）。
- 邏輯測試：`node --test tests/logic.test.mjs`（Windows 上不能寫成 `node --test tests/`）。新功能的出題、排程、解鎖邏輯要補測試。
- 介面文字一律台灣繁體中文；程式註解也用中文。

## 程式結構

- `js/srs.js`、`js/quiz.js` 是純函式（不碰 DOM、localStorage），測試直接 import；畫面邏輯都在 `js/app.js`。
- `app.js` 用 `el()` 建 DOM、`mount()` 掛到畫面（會濾掉 null）；`replaceChildren` 不會濾 null，傳入前要自己 filter。
- 狀態存在 localStorage 的 `kanaQuiz:state`，結構見 `js/storage.js` 的 `freshState()`。

## 和 SPEC 不同、或 SPEC 沒寫清楚的決定

- 誤選紀錄（wrongWith）在階段一就開始記錄；誤選記在「正解那個字」上（D 題記在對應的另一種假名），補干擾項時只用同一種假名。
- を／ヲ 不出聽音題（語音念成 o，和 お 分不出來）；ぢ、づ、ヂ、ヅ 不出看拼音選假名，也不出聽音題。
- 促音、長音（`sokuon`／`chouon`）只顯示說明卡，看過就記 `seen`，不進認讀排程、不擋解鎖；它們的練習留給階段四的單字題。
- 新字從 0 級進到 1 級不列入回合結束頁的「升級的字」。
- 新字的第二題：有日語語音時出聽音題（C），否則出看拼音選假名（B）。
- D（平片對照）只有在對應的另一種假名已經學過（read 等級 > 0）時才出。
- 語音挑選優先順序：Edge 的 Natural／Online 神經語音 → Google 日語 → 名稱含 Japanese／日本語 → 其他 ja 語音。
- 「記住」＝ read 等級 ≥ 3；首頁用 3 格顯示每個未記住字的等級，並有白話說明。

## 測試注意

- 這台 Windows 沒有日語語音，聽音題會被自動隱藏。要測聽音題畫面，在頁面裡改寫 `speechSynthesis.getVoices` 回傳一個假的 `ja-JP` 語音，再觸發 `voiceschanged` 事件。
- 內建瀏覽器在背景時 `requestAnimationFrame` 可能不觸發，反應時間有以 `performance.now()` 先記一次的保底。
- 測試完記得清掉 localStorage 的 `kanaQuiz:` 資料。
- 使用者主要裝置是 Android（Chrome）；手機版 Edge 沒有語音。

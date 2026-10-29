# kana-quiz 開發說明

50 音刷題網站。完整需求在 [SPEC.md](SPEC.md)，依「開發階段」逐段實作；每完成一個階段就停下來，讓使用者在手機上實測後再進下一階段。

## 目前進度

- 階段一～四全部完成並上線：<https://chungyilin2005-sys.github.io/kana-quiz/>
- 階段四（單字閱讀、長音 normalize、統計頁、混淆專練）等使用者手機實測回饋
- repo：<https://github.com/chungyilin2005-sys/kana-quiz>，部署方式為 GitHub Pages（main 分支、根目錄）

## 工作流程

- 每個階段完成後：跑測試 → commit → push 到 `main` → 等 Pages 更新（約 1 分鐘，可用 `curl` 檢查線上檔案是否已是新版）。
- commit 作者已在本 repo 的 git config 設為 GitHub noreply 地址；不要改成私人 Email（帳號開了 Email 隱私保護，push 會被擋）。
- 本機預覽：`.claude/launch.json` 的 `kana-quiz`（`python -m http.server 8000`）。若 8000 已被別的 session 的 server 占用（同一個資料夾），preview 會說改用別的 port 但其實沒起來；直接開 `http://127.0.0.1:8000/`，和 `localhost:8000` 是不同 origin，localStorage 不會互相干擾。
- 邏輯測試：`node --test tests/logic.test.mjs`（Windows 上不能寫成 `node --test tests/`）。新功能的出題、排程、解鎖邏輯要補測試。
- 介面文字一律台灣繁體中文；程式註解也用中文。

## 程式結構

- `js/srs.js`、`js/quiz.js` 是純函式（不碰 DOM、localStorage），測試直接 import；畫面邏輯都在 `js/app.js`。
- `js/words.js` 也是純函式：單字斷字轉拼音、長音 normalize（`normalizeWordRomaji`）、單字選項、單字回合、混淆字組與混淆專練。它和 `quiz.js` 互相 import（只在函式裡用，沒有循環初始化問題）。
- `js/write.js` 的 `parseKanjiVG`、`strokeFile`、`hasStrokeData` 也是純函式，可以直接測；筆順動畫和 `WritingPad` 才碰 DOM。
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
- 書寫開放條件（和 SPEC 不同）：SPEC 是認讀 2 級才開放，改成「學過的隔天就能寫」＝認讀 1 級以上，且 `read.since`（第一次學的日子）早於今天。`since` 由 `applyAnswer` 在字第一次進排程時記下；舊資料沒有 `since` 就視為早已學過。
- 書寫題（F）：write 等級 0 的字（剛開放、還沒寫過）也算「今天要寫」，排在到期的書寫題後面。今日練習先保留書寫名額：最多 8 題且不超過回合題數的 1/4（20 題回合留 5 題），剩下的才給認讀複習與新字。
- 書寫自評對應：寫對＝快且正確、大致對＝正確但慢、寫錯＝答錯，沿用 `applyAnswer`（同一天只升一次）。ぢ、づ、ヂ、ヅ 與促音、長音不出書寫題；拗音出，但只顯示範字不放筆順動畫。
- 書寫頁（#write）的單獨練習一回合 10 個字；都寫完時挑書寫等級低的字加練。紙筆／螢幕手寫的選擇記在 `settings.writeMode`。
- 單字題（G）的步驟是 `{ kind: 'q', word: true, id: 單字, type }`，type：W 選拼音、S 唸讀自評、T 打字。W／S 輪替；單字裡有讀音的假名都到 3 級以上才會出 T（SPEC 只列兩種做法，打字是為了讓長音 normalize 有地方用）。單字不進 Leitner 排程，只記在 `state.words[單字] = { n, ok, last }`，挑題時沒讀過的優先、再來最久沒讀的。
- 單字只看 `requires` 的單位是否解鎖，不管裡面的假名學過沒。
- 單字選拼音的干擾項：把 1 個假名換成它的 confusable（拼音不是英文字母的，如 `一`，跳過），促音、長音另外產生「漏掉」的寫法（kohii、kite）；不夠才用同類的已解鎖字替換。選項用 normalize 後的拼音去重。
- 答錯的單字把最弱（read 等級最低、有讀音）的假名記進 `state.focus`；下一個今日練習或加練回合把它當認讀複習排進來（佔複習名額），排進回合就從 `focus` 移除。0 級（還沒學）的字不排。唸讀自評答錯用 toast 提示，選拼音／打字答錯寫在回饋區。
- 單字閱讀頁一回合 10 個單字；可讀單字不足 5 個時停用按鈕，顯示「再解鎖 X 行」（依目前的平片同步設定模擬解鎖順序算出）。只有單字題的回合，結束頁不顯示「升級的字」。
- 長音 normalize：NFKC → 小寫 → ā／â 等變雙母音 → 去掉空白、連字號、撇號 → `ou` 一律視為 `oo`。所以 kyou、kyō、kyoo 都對；漏掉長音（kohii）算錯。
- 今日練習第 4 步的單字補題：`buildRound` 要傳 `words` 與 `index` 才會補。
- 混淆字組依 `wrongWith` 的「正解 → 誤選」方向列出前 10 組。混淆專練＝這兩個字＋正解第二常誤選的同種假名（最多 3 個），10 題輪流考、不連續考同一字、不出 D；選項用 `buildChoices` 的 `prefer` 優先放這幾個字。作答照常更新 read 等級。
- `applyAnswer` 會累計 `n`（作答次數）、`ok`（答對次數），統計頁點格子的「答題紀錄」顯示這兩個數字和上次反應時間（舊資料沒有就不顯示）。
- 統計頁 50 音表：認讀等級用單一藍色由淡到深（`color-mix`），右下小點大小與深淺表示書寫等級；未解鎖的格子是虛線框。濁音、拗音分頁平假名與片假名各一張表；促音、長音不列。每日練習量用 div 畫長條圖（沒有用 Chart.js），點或滑過長條顯示當天題數。
- 下拉重新整理只在書寫題畫面擋（`html.no-overscroll`，`setPage` 會移除），其他畫面照常可以下拉。

## 測試注意

- 這台 Windows 沒有日語語音，聽音題會被自動隱藏。要測聽音題畫面，在頁面裡改寫 `speechSynthesis.getVoices` 回傳一個假的 `ja-JP` 語音，再觸發 `voiceschanged` 事件。
- 內建瀏覽器在背景時 `requestAnimationFrame` 可能不觸發，反應時間有以 `performance.now()` 先記一次的保底。
- 測螢幕手寫可以對 canvas `dispatchEvent(new PointerEvent(...))`；本機預覽若 8000 被占用會改用別的 port，確認 server 真的有起來。
- 測試完記得清掉 localStorage 的 `kanaQuiz:` 資料。
- 使用者主要裝置是 Android（Chrome）；手機版 Edge 沒有語音。

# 50 音練習帖（kana-quiz）

給成人自學者的日文 50 音刷題網站：提取練習＋間隔重複＋形近字辨析。手機優先，每天 5～10 分鐘。

完整規格見 [SPEC.md](SPEC.md)。

## 目前進度：階段一

- 今日練習：到期複習＋每日新字（認識卡＋2 題簡單題）
- 題型：看假名選拼音（A）、看拼音選假名（B）、打字（E）
- Leitner 五級間隔重複；已解鎖的字全部達到 3 級時自動解鎖下一行
- 平假名清音（あ行～わ行）
- 回合結束頁：正確率、平均反應時間、升級的字、答錯的字
- 簡易設定：每日新字上限、每回合題數、手動解鎖、重設進度

## 本機測試

資料用 `fetch()` 載入，**不能直接雙擊開啟 `index.html`**（`file://` 下 fetch 會失敗），請開一個本機伺服器：

```bash
python -m http.server 8000
```

或

```bash
npx serve .
```

然後用瀏覽器開 <http://localhost:8000>。

### 用手機測試本機版本

手機和電腦連同一個 Wi-Fi，查出電腦的區域網路 IP（Windows：`ipconfig`），手機開 `http://<電腦IP>:8000`。Windows 防火牆第一次可能會詢問是否允許 Python 連線，選「私人網路」允許。

### 邏輯測試

```bash
node --test tests/logic.test.mjs
```

測試涵蓋 SPEC 第 14 節中與出題、排程、解鎖有關的驗收項目。

### Android 除錯

1. 手機「設定 > 關於手機」連點「版本號碼」7 次開啟開發人員選項。
2. 「開發人員選項 > USB 偵錯」打開，用 USB 線連接電腦。
3. 電腦 Chrome 開 `chrome://inspect`，找到手機上的分頁按「inspect」，即可看主控台錯誤。

## 部署

純靜態網站，沒有建置流程。推到 GitHub 後在 repo 的「Settings > Pages」選 `main` 分支、根目錄即可。

## 資料

- 進度存在瀏覽器 localStorage（key 前綴 `kanaQuiz:`），只存在單一瀏覽器。
- `data/kana-data.json`：211 個假名項目；`data/words.json`：69 個單字（階段四使用）。

# 南寺 キャンセル待ちウォッチャー

[ベネッセアートサイト直島](https://benesse-artsite.jp/) 家プロジェクト「南寺」の日時指定チケットを定期的に照会し、
**売り切れだった時間枠にキャンセルで空きが出たらメールで通知**します。

デフォルトは **2026-09-27（日）9:50 の枠** を監視します（`config.json`）。

---

## ログインもブラウザも要りません

南寺のチケットは [eventos](https://benesse-artsite.eventos.tokyo/web/portal/797/event/8483/module/booth/239565/222084?language=jpn)
で売られています。予約ページ自体はログイン必須ですが、ページが裏で叩いている在庫 API は
**ログインなし・素の HTTP リクエストで通ります**。Cloudflare のチャレンジも UA チェックもないため、
[e5489-watch](https://github.com/minoluke/e5489-watch) と違って Chrome は不要で、依存は `nodemailer` だけです。

### 在庫 API の構造

```
GET https://benesse-artsite.eventos.tokyo/web_api/v2/ticket/{portalId}/{eventId}/{contentId}
```

| クエリ | 返るもの |
| --- | --- |
| なし | 大分類（施設 × 月）の一覧。例「家プロジェクト「南寺」 2026年9月分」 |
| `?type=List&ticket_category_type=Large&ticket_category_id=…` | その施設の中分類（日付）一覧。例「2026/9/27」 |
| `?type=List&ticket_category_type=Middle&ticket_category_id=…` | その日の小分類（15分刻みの時間枠）一覧と `remaining_status` |
| `?type=List&ticket_category_type=Small&ticket_category_id=…` | その枠のチケットと **`remaining_count`（残り枚数）** |

`remaining_status` は3値です。

| 値 | 記号 | 意味 |
| --- | --- | --- |
| `enough` | ○ | 購入可能（残り11枚以上） |
| `few` | △ | 残りわずか（1〜10枚） |
| `none` | × | 売り切れ |

1回の照会は **中分類を1回**（その日の全枠が一度に取れる）＋ **空きのある監視枠ごとに小分類を1回**（残り枚数）です。
監視枠が売り切れのままなら1リクエストで済みます。

施設・日付の ID は `config.json` の施設名と日付から自動で引き、`state.json` にキャッシュします。
キャッシュした ID が別の日を指していたら引き直します。

---

## セットアップ

### 1. 依存パッケージ

```bash
npm install
```

Node.js 20 以上（`fetch` を使うため）。

### 2. 設定

**このリポジトリは公開しているため、メールアドレスとアプリパスワードはコミットしません。**

`config.json`（コミットする。監視条件だけ）:

```json
{
  "facility": "南寺",
  "date": "2026-09-27",
  "watchTimes": ["9:50"],
  "partySize": 1,
  "eventos": { "portalId": 797, "eventId": 8483, "contentId": 245856 }
}
```

| キー | 説明 |
| --- | --- |
| `facility` | 大分類のタイトルに含まれる施設名。「南寺」「きんざ」など |
| `date` | 来館日 |
| `watchTimes` | 監視する時間枠。複数書ける（`["9:50", "10:05"]`）。`09:50` と書いても可 |
| `partySize` | 何枚欲しいか。残り枚数がこれ未満なら「要確認」として通知します |
| `eventos` | eventos の portal / event / content ID。南寺のチケットページの URL から取ったもの |

`secrets.json`（**gitignore 済み**。ローカル実行用）:

```json
{
  "gmailUser": "you@gmail.com",
  "to": "you@gmail.com, another@example.com",
  "gmailAppPassword": "xxxx xxxx xxxx xxxx"
}
```

Gmail の通常パスワードでは送信できません。2段階認証を有効にしたうえで
[アプリパスワード](https://myaccount.google.com/apppasswords)（16桁）を発行してください。
`to` はカンマ区切りで複数指定できます。

GitHub Actions で動かす場合は、同じ値をリポジトリの Secrets に登録します
（`Settings > Secrets and variables > Actions`、または `gh secret set`）:

| Secret 名 | 中身 |
| --- | --- |
| `GMAIL_APP_PASSWORD` | アプリパスワード16桁 |
| `GMAIL_USER` | 送信元の Gmail アドレス |
| `MAIL_TO` | 通知先アドレス（カンマ区切りで複数可。省略時は `GMAIL_USER`） |

環境変数 → `secrets.json` の順に探すので、ローカルと CI で同じコードが動きます。

### 3. 動作確認

```bash
node check.js --no-email   # 照会するだけ。メールは送らない
node check.js --test-email # メールの疎通確認だけ
```

### 4. GitHub Actions で動かす（既定の運用）

**GitHub はスケジュール実行を負荷に応じて激しく間引きます。** e5489-watch で実測したところ、
30分間隔で登録しても実際の起動は1日7〜8回、間隔の中央値は179分でした。

そこで **1回起動されたら1つのジョブの中で長時間ループし、自前で間隔を刻む**方式にしています。
GitHub が間引けるのは起動だけで、走り出したジョブの中の `sleep` には干渉しません。

| 環境変数 | 既定 | 意味 |
| --- | --- | --- |
| `LOOP_MINUTES` | 330 | ループを回す時間（分）。GitHub のジョブ上限は6時間 |
| `CHECK_INTERVAL` | 60 | 照会が終わってから次を始めるまでの待ち時間（秒）。照会は1〜2秒なので実効間隔もほぼこの値 |

1回の起動が5.5時間をカバーするため、起動が数時間おきでも監視は途切れません。
`concurrency` は `cancel-in-progress: true` にしてあり、新しく起動されたら古いループを止めて引き継ぎます。

手動実行（`workflow_dispatch`）はループせず1回だけ照会します。監視ループとは別の
concurrency グループなので、手動実行が走っているループを巻き添えで止めることはありません。

```bash
gh workflow run watch.yml -f dry_run=true       # 照会だけ
gh workflow run watch.yml -f test_email=true    # メール疎通確認
```

public リポジトリなら Actions の実行時間は無制限・無料です。

---

## 通知の挙動

- 通知するのは **監視枠が `×`（売り切れ）→ `△`／`○` に変わった瞬間**だけです。空いている間ずっと鳴り続けることはありません。
- 再び売り切れになり、その後また空けば改めて通知します。
- メールには **ログイン後にその日の時間枠一覧が出る予約 URL** と、その日の全枠の状況が入ります。
- 残り枚数が `partySize` 未満のときは「要確認」として通知します。
- 照会に失敗した枠の状態は前回値を保持します（失敗を「売り切れ」と誤認して二重通知しないため）。
- `config.json` の施設や日付を変えると、過去の状態は自動的に破棄されます。

## いつまで監視するか

チケットの販売は **各枠の開始時刻ちょうどまで**、キャンセルの受付は **その30分前まで**です
（9:50 の枠なら 9:20 までキャンセルが出うる）。監視する最後の枠の時刻を過ぎると `check.js` は
終了コード 9 で抜け、GitHub Actions 側がスケジュールを自動で無効化します。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `check.js` | 本体。照会・比較・通知 |
| `config.json` | 監視条件 |
| `state.json` | 前回の状態と解決済み ID。毎回変わる値は入れない（差分があるときだけコミットするため） |
| `secrets.json` | メール認証情報（gitignore 済み） |
| `.github/workflows/watch.yml` | GitHub Actions のループ実行 |

## 注意

- 個人のチケット確保のための利用にとどめてください。間隔を極端に詰めるとサイトに負荷がかかります。
- サイトの API 構造が変わると取得に失敗します。その場合は「枠一覧を取得できませんでした」等のログが出ます。

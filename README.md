# Trading Card Gacha MVP

Node.js 20+ の標準 HTTP サーバーで動く、Issue #1 のローカルMVPです。外部DBがなくても動作確認できるよう、データは `data/store.json` に原子的に保存します（`GACHA_DATA_FILE` で変更可能）。

## 起動

```sh
npm test
npm start
```

ブラウザで `http://localhost:3000/` を開くと、登録・ログイン、パック詳細、1/10/全口抽選、演出、カード一括還元、配送先登録、発送申請、ポイント履歴を操作できます。

デモ管理者は `admin@example.com` / `admin-dev-password` です。管理者トークンで `POST /api/admin/points`（`{"userId":"...","amount":1000}`）を呼ぶとポイントを付与できます。本番では必ず認証基盤と管理者資格情報を置き換えてください。

## API概要

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/packs`, `GET /api/packs/:id`（残口数・レアリティ別確率）
- `POST /api/draw`（`packId`, `quantity`; 1/10/残り全部に対応）
- `GET /api/cards`, `POST /api/cards/redeem`, `GET /api/transactions`
- `GET/POST /api/addresses`, `GET/POST /api/shipments`
- `GET /api/effects`
- `POST /api/admin/auth/login`（メール・パスワード・6桁TOTP）, `POST /api/admin/auth/logout`, `GET /api/admin/environment`
- `POST /api/admin/points`（ownerのみ、理由必須、開発/本番確認）, `GET /api/admin/users`（email/id/phone検索）, `GET /api/admin/users/:id`（購入・抽選・カード・発送履歴）, `PATCH /api/admin/users/:id`（凍結/解除/退会）, `GET /api/admin/draws` / `GET /api/admin/draws.csv`（user/pack/期間/rarity）, `GET /api/admin/inventory`（管理専用の残口・レア残数）, `GET /api/admin/anomalies`（表示のみ）, `GET /api/admin/audit-logs`
- `GET/POST /api/admin/cards`, `PATCH/DELETE /api/admin/cards/:id`, `GET /api/admin/cards.csv`, `POST /api/admin/cards/import`（CSV）
- `GET/POST /api/admin/packs`, `PATCH /api/admin/packs/:id`, `POST /api/admin/packs/:id/duplicate`
- `GET/POST /api/admin/effect-ranks`, `POST /api/admin/effects`（mp4/WebM URL、20MB以下のメタデータ検証、未設定時フォールバック）
- `GET /api/admin/shipments`, `PATCH /api/admin/shipments/:id`（`requested` / `processing` / `shipped` / `canceled`、追跡番号）

抽選はサーバー側 `crypto.randomInt` のCSPRNGで、発行済みスロットを一度だけ消費します。ポイント減算、スロット更新、抽選ログ、獲得カード作成は同一Mutex下の処理で、失敗時は状態を復元します。抽選ログはSHA-256ハッシュチェーンで改変を検出でき、管理画面から検証状態を確認できます。

## 管理者P0（Issue #4/#6）

管理者は通常ユーザーセッションと別の `/api/admin/auth/login` を使用し、RFC 6238互換の6桁TOTPを必須とします。管理者セッションは8時間で失効し、ログイン時IPと環境（`ADMIN_ENV=development|production`）に束縛されます。`ADMIN_ALLOWED_IPS=ip1,ip2` で許可IPを設定できます。ロールは `owner`（全操作）、`operator`（パック・カード・発送）、`viewer`（参照）で、認可はサーバー側で検証します。

2FA秘密はAES-256-GCMで暗号化して `adminUsers[].twoFactorSecretEnc` に保存し、平文は保存しません。暗号化キーは `ADMIN_2FA_KEY`（本番では必須の秘密管理サービスから注入）です。開発用デモ管理者のTOTP秘密は `JBSWY3DPEHPK3PXP` で、認証アプリへ登録して現在の6桁コードを使用します。`ADMIN_2FA_SECRET` で差し替えられます。本番の初期作成時は `ADMIN_2FA_SECRET` と `ADMIN_2FA_KEY` の両方が必須です。外部認証・メール・SMS・秘密管理サービスはこのゼロ依存MVPでは偽装せず、環境変数注入の代替としています。リバースプロキシ配下で接続元IPヘッダーを利用する場合に限り `TRUST_PROXY=true` を設定します。

管理操作は `adminAuditLogs` に追記専用で保存され、actor/action/target/before/after/IP/日時/理由を記録します。ポイント操作は `pointTransactions` と監査ログ、残高を同一Mutexトランザクションで更新し、owner以外は操作できません。ユーザーの凍結・解除・退会、抽選ログの条件検索/CSV、管理専用レア残数、簡易高額当選検知（自動凍結なし）を提供します。ポイント操作、パック停止、管理者変更などは理由必須です。本番の破壊操作は `confirmProduction: true` と理由がなければサーバーが拒否します。開発用・本番用は `ADMIN_ENV` と `GACHA_DATA_FILE` を別デプロイで分け、1画面内のDB切替は行いません。

## 残課題

Stripe決済、SMS/メール認証、動画ファイルの実ストレージ・自動リサイズ、パスワードリセット、管理画面フル機能、購入上限、保管期限による自動還元は未実装です。画像/動画はローカルMVPでは外部URLまたは検証済みdata URLを保持し、実ファイルのリサイズ・配信はストレージ/CDN導入時の残課題としています。発送ステータス更新と抽選ログCSVエクスポート、管理者P0認証・監査基盤、カード/パック/演出の管理API、P2ユーザー/ポイント/在庫モニタAPIは実装済みです。決済・本人確認・動画ストレージ・本番の秘密管理は外部サービス連携が必要なため、ローカルMVPでは偽の成功応答を返しません。

JSONストアとプロセス内MutexはローカルMVP向けです。複数プロセスで運用する前にPostgreSQLへ移行し、抽選処理をトランザクションと行ロックで保護してください。デモ管理者資格情報、セッショントークン保存、HTTPS終端も本番用の認証・インフラへ置き換える必要があります。

## P3 運用（Issue #2/#6）

発送一覧は `GET /api/admin/shipments`、状態・追跡番号の更新は `PATCH /api/admin/shipments/:id`、宛名・住所・カードを含むラベルCSVは `GET /api/admin/shipments.csv` で取得できます。ユーザーの `GET /api/shipments` にも状態・追跡番号・カードが反映されます。CSVのセルは式インジェクションと引用符をサニタイズします。

ポイント購入は `POST/GET /api/payments`、管理者履歴は `GET /api/admin/payments` です。`Store#setPaymentProvider` または `new Store(file, { paymentProvider })` で `createPayment` と `refund`（または `refundPayment`）を注入できます。provider未設定時は決済を `pending` とし、Stripe成功を偽装しません。返金は `refund_pending` → `refunded` / `refund_failed` の再実行可能な状態機械で、ポイントを先に予約し、失敗時は解放します。providerには決済由来の固定 `idempotencyKey` を渡すため、実Stripe連携でも同じキーを使用してください。ポイント調整・監査ログ・二重返金防止を同一ストアで管理します。

銀行振込は `POST /api/bank-transfers`、入金消込は owner専用の `POST /api/admin/bank-transfers/:id/reconcile`（理由必須）です。サイト設定・お知らせは `GET /api/site-settings` と owner/operator専用の `PATCH /api/admin/site-settings`、`POST /api/admin/announcements` でノーデプロイ更新できます。ダッシュボードは owner/operator/viewer が `GET /api/admin/dashboard` で日/月売上、抽選数、還元率、pack別残口・レア残、直近高額当選、発送待ちを確認できます。

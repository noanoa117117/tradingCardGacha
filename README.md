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
- `POST /api/admin/points`, `GET /api/admin/users`, `GET /api/admin/draws`
- `POST /api/admin/cards`, `POST /api/admin/packs`, `POST /api/admin/effects`

抽選はサーバー側 `crypto.randomInt` のCSPRNGで、発行済みスロットを一度だけ消費します。ポイント減算、スロット更新、抽選ログ、獲得カード作成は同一Mutex下の処理で、失敗時は状態を復元します。抽選ログはSHA-256ハッシュチェーンで改変を検出でき、管理画面から検証状態を確認できます。

## 残課題

Stripe決済、SMS/メール認証、動画ファイル自体のアップロード、パスワードリセット・退会、発送ステータス更新、管理画面フル機能、2FA/IP制限、購入上限、保管期限による自動還元は未実装です。

JSONストアとプロセス内MutexはローカルMVP向けです。複数プロセスで運用する前にPostgreSQLへ移行し、抽選処理をトランザクションと行ロックで保護してください。デモ管理者資格情報、セッショントークン保存、HTTPS終端も本番用の認証・インフラへ置き換える必要があります。

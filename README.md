# Narrow One – Cloudflare Workers プロキシ

`narrow.one` のページ・スクリプト・API を同一オリジンで中継する Worker です。`/config/` 以下は実際の配信元である `https://narrow-one.com` へ送り、マップの `.glb` / `.nasset`、設定 JSON、サムネイルも中継します。バイナリや Range (`206 Partial Content`) は加工・一括読み込みせずストリーミングします。ファイルのコピーや固定のバージョン番号は不要です。

## 使い方

Cloudflare アカウントと Node.js 20 以上が必要です。

```sh
npm ci
npm test
npm run check       # デプロイせずに Worker をビルド
npx wrangler login  # 自分の環境で Cloudflare にログイン
npm run deploy
```

デプロイ後、Wrangler が表示する `https://narrow-one-proxy.<account>.workers.dev/` にアクセスしてください。独自ドメインを使う場合は Cloudflare 側で Worker にルートまたはカスタムドメインを割り当ててください。`wrangler.toml` の `name` は必要に応じて変更できます。

ローカル起動は `npm run dev` です。ただしローカル環境から上流 2 ドメインへの通信が必要です。

## 経路

| ブラウザからのパス | 上流 |
| --- | --- |
| `/`, `/js/*`, `/static/*`, `/api/*`, `/maps/*` など | `https://narrow.one` |
| `/config/*`（`/config/maps/*.glb` も含む） | `https://narrow-one.com` |

上流の HTML / JS / CSS に含まれる `narrow.one` の絶対 URL、および `narrow-one.com/config/` の絶対 URL は Worker の URL に置き換えます。相対 URL はそのまま動きます。`narrow-one.com` の **その他の** URL、マッチメイキング・広告などの外部サービスへの接続はブラウザから直接行います（`narrow-one.com` は直接アクセス可能という前提）。上流の同一オリジン WebSocket Upgrade は転送しますが、外部ゲームサーバーの WebSocket は Worker を通りません。

GET / HEAD に加えて POST 等のメソッドとリクエスト本文、Cookie、リダイレクトを扱います。`/config/` 宛てには Cookie / Authorization を送信しません。転送先ホストは上記 2 件に固定され、任意 URL を指定できる公開プロキシにはなりません。

## 注意事項

- デプロイ先での実ゲーム接続やログイン連携は未検証です。上流サイトが接続先・認証方式・CSP・アセットパスを変更した場合は調整が必要になります。特に外部 OAuth のリダイレクトや外部 WebSocket の規制環境では、一部機能が動かない可能性があります。
- 上流サイトの利用規約およびアセットの権利を遵守してください。非公式のプロキシであり、Pelican Party Studios とは無関係です。

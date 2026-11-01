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

## Pelican Party ログインについて

2026-10-31 のゲームバンドルでは、Pelican Party SDK の読み込み完了前にログイン画面を開くと、Pelican Party ボタンが表示されない場合があります。対応するバンドルではログイン画面を開く前に最大5秒待ち、SDKが準備できない場合は注意を表示します。上流のコードが変わった場合、この限定的な修正は適用されません。

SDKへの直接接続に失敗した場合は、公開SDKのJavaScriptだけを `/__narrow_peli_sdk/` 経由で再取得します。転送先は `js.pelicanparty.games` の固定パスに限定し、Cookie・認証情報は送信せず、レスポンスはキャッシュしません。**これはログイン全体のプロキシではありません。** Pelican Partyのログイン画面と認証APIは依然としてブラウザから直接接続するため、それらに接続できない環境ではログインできません。パスキーや上流側のドメイン制限も未対応です。実アカウントでのログインは未検証です。

調査では、Workerから公式ログインページを匿名で取得できることを確認しました。一方、SDKは公式ログインページのオリジンを検証して認証結果を受け取り、認証APIにも接続します。画面だけをコピーしてもログインは完了しません。認証情報を扱う中継には、セッション・CSRF・Cookieの分離、実際の上流認証フロー、パスキーとドメインの制限を十分に検証する必要があるため、このWorkerには追加していません。

## Google / Discord ログインについて

Google や Discord の認証ページはプロキシせず、ブラウザから各サービスに直接接続します。外部の認証 URL とその `redirect_uri`、`state` 等は書き換えません。パスワードは各サービスの正規ページでのみ入力してください。

2026-10-31 のゲームの認証処理では、公開設定 `narrow-one.com/api/auth/getIssuerConfig` を取得し、同ドメインの `auth/oAuthCallback` を戻り先に使います。公開設定の直接取得が通信エラーで失敗した場合だけ、Worker の `/__narrow_login/issuer` を介して再取得します。対象は Google、Discord、itch.io、Facebook、Apple の固定 issuer に限り、Cookie・Authorization は転送しません。設定取得やセッション取得に失敗した場合は、ゲーム画面に追加のエラーを表示します。認証トークンを含む POST の再送や、Google・Discord・コールバックのプロキシはしません。

**通常の `workers.dev` や独自ドメインではログインできない可能性が高いです。** 2026-10-31 に取得された Google / Discord / itch.io / Facebook / Apple のコールバック HTML は、ポップアップの開き元を `narrow.one` とそのサブドメイン、特定の Poki ドメイン、またはコールバック自身のホスト名に制限し、それ以外には `An error occurred: invalid origin.` と表示します。公開設定の取得に成功しても、この制限は解消されません。対象外のドメインでは、認証を始める際に注意を表示します（上流の仕様は変更される場合があります）。

これは上流のセキュリティ設定であり、Worker から変更できません。プロキシ上でのログインには上流運営者がドメインを許可する必要があります。公式サイトでログインすることはできますが、別オリジンなので Worker 側のセッションには自動的に引き継がれません。独自の Google / Discord OAuth アプリを作成しても、Narrow One の既存アカウントには自動的に接続できません。

ログインできない場合は、ブラウザの開発者ツールで失敗した通信のパス、HTTP ステータス、エラーメッセージを確認してください。認証コード、トークン、Cookie、メールアドレス等の機密情報は共有しないでください。

## 注意事項

- デプロイ先での実ゲーム接続やログイン連携は未検証です。上流サイトが接続先・認証方式・CSP・アセットパスを変更した場合は調整が必要になります。特に外部 OAuth のリダイレクトや外部 WebSocket の規制環境では、一部機能が動かない可能性があります。
- 上流サイトの利用規約およびアセットの権利を遵守してください。非公式のプロキシであり、Pelican Party Studios とは無関係です。

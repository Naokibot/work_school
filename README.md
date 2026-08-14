# Memory / work_school

GitHub Pagesだけで動く、iPad向けのFSRS暗記Webアプリです。

## 主な機能

- FSRSによる復習スケジューリング（Again / Hard / Good / Easy）
- iPad Safari向けレスポンシブUI
- 外付けキーボード操作（Space、1〜4）
- サイトからカード追加・編集・削除
- Google Sheets同期
- IndexedDBによる端末内保存
- CSVインポート / エクスポート
- 学習履歴を含むJSONバックアップ / 復元
- 学習統計・ストリーク
- PWA / オフライン学習
- GitHub ActionsからGitHub Pagesへ自動デプロイ

## Google Sheets

初期設定では次のスプレッドシートを読み込みます。

- Spreadsheet ID: `147eZ_4pocwkxQSs3QRC0SevZaojcdwK8V7777td_xos`
- gid: `0`
- A列: 問題
- B列: 答え

A列とB列の両方に値が入っている行をカードとして取り込みます。1行目が `問題 / 答え`、`question / answer` などの見出しの場合は自動的に除外します。

Google Sheets側は、サイトから閲覧できるよう「リンクを知っている全員が閲覧可」などの共有設定が必要です。認証が必要な非公開シートは、GitHub Pagesだけの構成では直接同期できません。

同期は起動時、オンライン復帰時、アプリが前面に戻った時、およびサイトを開いている間は約60秒ごとに行います。手動同期ボタンもあります。

Google Sheetsから消えた行を同期時に自動削除することはありません。誤操作でFSRS学習履歴まで消えることを防ぐためです。Sheets由来カードを完全に消したい場合は、先にスプレッドシートの該当行を削除し、その後サイト側のカード一覧から削除してください。シートに行が残っている限り、次回同期でカードは再作成されます。

## データ保存について

カード、FSRS状態、回答履歴、設定はブラウザのIndexedDBへ保存します。そのため、同じURLでもiPadとPCは別データです。

端末変更前には「設定 → JSON保存」でバックアップしてください。

Google Sheets由来カードでは、問題・答え・行情報だけを同期し、FSRSの復習履歴は端末側に保持します。行の挿入や並べ替えがあっても、問題と答えが同じカードは既存の学習履歴をできる限り引き継ぎます。

## ローカル開発

Node.js 22以降を使用します。

```bash
npm install
npm run dev
```

型検査と本番ビルド:

```bash
npm run build
```

## GitHub Pages

`main` へpushすると `.github/workflows/deploy-pages.yml` が実行されます。

公開URLは通常次の形式です。

```text
https://naokibot.github.io/work_school/
```

### 初回だけ必要な設定

このリポジトリでは、GitHub Actionsのトークンだけでは新しいPagesサイト自体を有効化できません。最初の1回だけGitHubの画面で次を設定してください。

1. `work_school` リポジトリを開く
2. `Settings` → `Pages`
3. `Build and deployment` の `Source` を `GitHub Actions` にする
4. `Actions` → `Deploy GitHub Pages` → `Run workflow` を実行する

以後は `main` へのpushだけで自動ビルド・自動デプロイされます。

## iPadでの利用

Safariで公開URLを開き、共有ボタン →「ホーム画面に追加」を選ぶと、ホーム画面から起動できます。一度読み込んだアプリ本体と端末内カードはオフラインでも利用できます。Google Sheets同期だけはオンライン接続が必要です。

## セキュリティ上の注意

GitHub Pagesは静的サイトなので、Google OAuthクライアントシークレットやAPI秘密鍵は置かないでください。このアプリは公開閲覧可能なGoogle Sheetsを読み込む方式のため、シートに秘密情報や個人情報を置かないでください。

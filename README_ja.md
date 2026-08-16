# dsh-code-ide

[简体中文](README_zh-CN.md) | [English](README_en.md) | **日本語** | [Deutsch](README_de.md)

`dsh-code-ide` は、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に任意で利用できる IDE ワークベンチを追加するプラグインです。公式のホーム、チャット、セッション、設定、ツール UI は置き換えません。

> [!IMPORTANT]
> 現在のバージョンは `0.1.0-alpha.0` です。正式リリースおよび npm パッケージはまだ公開されていません。開発対象は DeepSeek Harness のソースコミット `47f9438`（マニフェスト上は `0.1.0-rc.5`）に固定されています。

## 概要

インストールすると、Harness の会話画面にネイティブな **IDE** タブが追加されます。既定表示は引き続きチャットです。IDE はタブを選択したときだけ生成され、そのセッションで IDE を表示している間だけ通常の入力欄が非表示になります。チャットへ戻ると入力欄も復元されます。

ワークベンチは同一オリジンの `/dsh-code-ide/` から配信され、IDE タブ内に埋め込まれます。対象ワークスペースは親セッションから受け取り、Harness のライト／ダークテーマと `en`／`zh` の言語変更に追従します。Harness クライアントを fork しない、追加型の統合です。

操作体系は VS Code のワークベンチを参考にしていますが、Code - OSS のビルドではなく、VS Code 拡張ホストも備えていません。

## 主な機能

- 遅延読み込み式の Explorer、ファイルアイコン、展開状態の保持、キーボード操作、ワークスペース相対パスの検証。
- CodeMirror 6 による 20 言語モード、複数タブ、最大 4 グループ、上／右方向への分割、タブのドラッグ／キーボード並べ替え、文書別 Undo、改行・インデント・折り返し設定。
- バージョン確認付き保存、競合処理、削除済みファイルの再作成、ブラウザー内ホットイグジット復元、外部変更のポーリング。
- Quick Open、ワークスペース検索、正規表現・大文字小文字・単語・include/exclude、結果移動、プレビュー後に適用する置換。置換後のバッファーは自動保存されません。
- Command Palette と、競合検出付きの編集可能な 1～2 ストロークショートカット。
- ワークスペースを作業ディレクトリとする複数の xterm.js 端末。検索、消去、名前変更、再起動、中断、終了に対応。端末パネルを折りたたんでも表示が隠れるだけで、PTY はアンマウントも停止もされません。
- サイズ変更可能なペインと、760 CSS px 以下でのアクセシブルなコンパクト表示。
- 英語・簡体字中国語 UI。Harness の言語変更を再読み込みなしで反映。
- 診断用の単独 `/dsh-code-ide/` ルート。通常は Harness `/` の **IDE** タブから開きます。

## 必要環境

- Node.js `^22.19.0` または `>=24.0.0`。
- Corepack と pnpm。本リポジトリは pnpm `10.17.0`、対象 Harness は現在 `11.7.0` を固定。
- DeepSeek Harness ソースコミット `47f9438`。
- WebSocket、`localStorage`、Web Locks を利用できる同一オリジンの最新ブラウザー。Web Locks がない場合、復元の書き込み所有権やショートカット編集は無効または読み取り専用になります。
- `@vscode/ripgrep@1.18.0` が提供する対象 OS 用バイナリ。
- Harness Host 側から提供される厳密な `node-pty@1.1.0` peer。欠落や別バージョンは互換性エラーです。別コピーを追加ビルドしないでください。

対応する Harness RC の依存グラフはレジストリに完全公開されていません。古い npm `0.0.1-rc.1` は非互換のため、レジストリだけでのインストールはサポートしません。

## ローカル `.tgz` からインストール

1 つのインストールでは、`plugin add`、`plugin list`、`--dump-config`、`web` のすべてで同じ `DSH_HOME` を使用してください。明示的に設定する場合は、次のコマンドを実行する前に同じシェルで一度だけ export します。別の値を使うと、別の profile ストアが選ばれます。

Harness を準備します。

~~~sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 47f9438
corepack pnpm install --frozen-lockfile
corepack pnpm build
~~~

別のチェックアウトで本プロジェクトをパックします。

~~~sh
git clone https://github.com/SakalioLabs/dsh-code-ide.git
cd dsh-code-ide
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm pack
~~~

Harness 側から生成された tarball の絶対パスを指定します。

~~~sh
corepack pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide-0.1.0-alpha.0.tgz
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
~~~

## ローカルソースからインストール

~~~sh
# dsh-code-ide 側
corepack pnpm install --frozen-lockfile
corepack pnpm build

# deepseek-harness@47f9438 側
corepack pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
~~~

これは開発用の手順であり、公開インストールの保証ではありません。`strictDepBuilds` が Git 依存のビルドを止めた場合は、生成された正確なパッケージキーだけを確認して許可し、ポリシー全体を無効化しないでください。

## 設定

パッケージの `dsh.bundle` パッチが次の 1 行を自動追加します。

~~~yaml
- insert:
    - id: dsh-code-ide
      name: dsh-code-ide
      config:
        maxFileBytes: 4194304
        terminalShell: auto
~~~

`examples/dsh-code-ide.bundle.patch.yml` は参照用です。ユーザーパッチへ重ねてコピーすると行が重複します。変更後は `--dump-config` で IDE が 1 件だけであり、公式 Web エントリーが残っていることを確認してください。

| 項目 | 既定値 | 内容 |
|---|---:|---|
| `maxFileBytes` | 4 MiB | 編集可能な UTF-8 ファイルの読み書き上限。 |
| `maxDirectoryEntries` | 5,000 | 1 回の一覧で返す直下項目数。 |
| `terminalShell` | `auto` | Windows は `COMSPEC`、Unix は `SHELL` を使用。 |
| `terminalArgs` | シェル既定 | シェルへ渡す明示的な引数配列。 |
| `maxTerminalSessions` | 8 | Host 全体の接続中／接続待ち PTY 上限（最大 64）。 |
| `maxConcurrentSearches` | 2 | 同時検索プロセス数。 |
| `searchTimeoutMs` | 30,000 | 検索タイムアウト（ms）。 |

その他の上限は [`src/host/plugin.ts`](src/host/plugin.ts) にあります。構造操作の設定値は admission と recovery のリソースを制限し、実際に利用できるかどうかはレビュー済み Host backend とファイルシステムによって決まります。ルートは `/dsh-code-ide` 固定です。

## 使い方

1. `web` profile を起動し、`http://127.0.0.1:3080/` を開きます。
2. Harness ワークスペースに属するセッションを開くか作成します。
3. 会話ビューの **IDE** を選択します。
4. Explorer または Quick Open からテキストファイルを開き、編集して保存します。
5. **Search** で検索と置換プレビューを行い、変更したバッファーは別途保存します。
6. 端末ツールバーから端末を作成します。コマンドは現在のローカルユーザー権限で実行されます。
7. Harness の入力欄や会話 UI が必要なら Chat に戻ります。

セッションのワークスペースが読込中、利用不能、未関連付けの場合、別のワークスペースへ勝手に切り替えず状態を表示します。

`http://127.0.0.1:3080/dsh-code-ide/` を直接開くと、ワークスペース選択と Harness ペインを備えた単独モードになります。埋め込みモードでは親セッションがその情報を持つため表示しません。

## 既定ショートカット

| 操作 | Windows/Linux | macOS |
|---|---|---|
| Command Palette | `Ctrl+Shift+P` または `F1` | `Cmd+Shift+P` または `F1` |
| Quick Open | `Ctrl+P` | `Cmd+P` |
| 保存 | `Ctrl+S` | `Cmd+S` |
| Explorer / Search | `Ctrl+Shift+E` / `Ctrl+Shift+F` | `Cmd+Shift+E` / `Cmd+Shift+F` |
| 行へ移動 | `Ctrl+G` | `Cmd+G` |
| ショートカット設定 | `Ctrl+K`、続けて `Ctrl+S` | `Cmd+K`、続けて `Cmd+S` |
| 端末表示切替 | `Ctrl+Backtick` | `Cmd+Backtick` |
| 行折り返し | `Alt+Z` | `Option+Z` |

Explorer は矢印、Home/End、Enter、Space、`*`、文字入力検索に対応します。フォーカス中のエディタータブでは Left/Right、Home/End、Delete、`Alt+Shift+Left/Right` を使用できます。端末検索は Enter が次、Shift+Enter が前、Escape が閉じる操作です。

## 制限とセキュリティ

- 不安定な上流へ固定した初期段階のローカル開発ツールです。他コミットや移動ブランチ、別 RC は未サポートです。
- Windows x64 のローカル NTFS ワークスペースでは、現在の Host がファイル／フォルダー作成、移動／名前変更、完全削除をサポートします。他 OS または未対応ファイルシステムでは利用できません。完全削除はごみ箱を使わないため、確定前に対象パスと recovery 状態を確認してください。
- VS Code 拡張、拡張ホスト、LSP 補完、デバッガー、ソース管理 UI、バイナリエディター、マルチルートには対応しません。
- IDE endpoint は loopback と同一オリジンを要求します。LAN や Internet へ公開しないでください。遠隔ユーザー認証、TLS、プロセス分離、quota、監査ログはありません。
- パス検証は traversal と確認済み symlink を拒否しますが、同一ユーザーの別プロセスに対する OS sandbox ではありません。
- 端末は現在ユーザーの権限を持ちます。機密らしい環境変数名は denylist で除去しますが、秘密情報を保証する sandbox ではありません。
- 未保存テキストとショートカット設定は同一オリジンの `localStorage` に平文で保存される場合があります。復元は有限かつ best-effort です。
- 外部変更は polling であり native watcher ではありません。端末状態はハードリロード後に復元されません。
- アプリ UI は英語と簡体字中国語のみです。この日本語文書は日本語 UI を意味しません。

利用前に [`docs/security.md`](docs/security.md) と [`docs/compatibility.md`](docs/compatibility.md) を確認してください。

## 開発とテスト

~~~sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
~~~

`pnpm build:host`、`build:client`、`build:harness-client` で各ターゲットを個別ビルドできます。`pnpm dev` は Vite のみを起動し、Host API には統合環境が必要です。`dist/` を直接編集しないでください。

## ライセンス

本プロジェクトは [MIT License](LICENSE)、Copyright © 2026 SakalioLabs です。同梱する Seti UI ファイルアイコンも MIT であり、帰属表示は [ThirdPartyNotices.txt](ThirdPartyNotices.txt) にあります。

## 更新とアンインストール

Harness を停止し、新しい tarball へ入れ替えます。

~~~sh
corepack pnpm dsh plugin --profile web remove dsh-code-ide
corepack pnpm dsh plugin --profile web add /absolute/path/to/new/dsh-code-ide-0.1.0-alpha.0.tgz
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
~~~

同じ `DSH_HOME` で `pnpm dsh web` を再起動し、ブラウザーを強制再読み込みしてください。アンインストール時も同じ `DSH_HOME` で `remove`、`plugin list`、`--dump-config` を実行します。ブラウザー内の復元・ショートカット情報は自動削除されません。

## リリースノート

公開リリースはまだありません。現在の `0.1.0-alpha.0` は、上記の Harness 固定版に対するローカルソースまたは `.tgz` 評価用です。過去のテスト成果物はリリースではなく、現在のソースを証明するものでもありません。

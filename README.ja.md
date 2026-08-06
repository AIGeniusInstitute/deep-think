**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  セルフホストのマルチユーザー・ローカル AI Agent Loop Engineering システム（デスクトップ＋ブラウザ＋モバイル） / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deepthink/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <img src="static/deep-think-intro.gif" alt="DeepThink Intro" width="800" />
</p>


## DeepThink とは

DeepThink、エンタープライズグレードの自律型 Agent 自己進化スーパーインテリジェンスプラットフォーム。Harness Engineering から Loop Engineering パラダイムへの移行の先駆者であり、エンタープライズ顧客向けの次世代 AI インフラストラクチャ（AI Infra）です。DeepThink プラットフォームはマルチ Agent コラボレーションフレームワークを中核とし、AI Coding、Self-Evolving、Full-Stack Observability、Bug Auto-Fix Loop、Human-Agent Symbiosis を融合して、継続的に学習し自己改善し、最終的にスーパーインテリジェンスへと成長するエンタープライズグレードの AI システムを構築します：

- **AI 自律型 R&D プラットフォーム** — Agent がソフトウェア開発の全ライフサイクルを独立して完遂し、ルーチンなコーディング作業に人間エンジニアを必要としません
- **自己進化型 Agent エンジン** — Agent はエラーから継続的に学び、コードベースから知識を吸収し、ユーザーフィードバックから進化します
- **プログラマー-Agent コラボレーションハブ** — 各プログラマーは複数の並列セッションを含む個人「開発プロジェクト」を持ち、中央スケジューラが並行処理の競合を防ぎます
- **エンタープライズ SaaS プラットフォーム** — マルチテナント分離、階層型権限、弾力的な課金、エンタープライズ連携（Feishu/DingTalk/WeCom/LDAP）
- **スーパーインテリジェンスインキュベータ** — 継続的な進化を通じて、単一の Agent は最終的に完全なソフトウェアチームの総合的な能力を獲得します

> 「すべての企業が、決して止まることなく継続的に進化する AI スーパー R&D チームを持てるように — ツールの利用者から、コードの創造者へ、最終的には自己増殖するスーパーインテリジェンスへと成長する。AGI への道を共に歩んでいきましょう。」

### 主な特徴

- **ネイティブ Claude Code 駆動** — Claude Agent SDK ベース、内部ランタイムは完全な Claude Code CLI、全能力を継承
- **Harness & Loop Engineering** — バージョン管理されたハーネスマニフェスト（システムプロンプト / サブエージェント / ツール / スキル）でスナップショット / 差分 / 評価 / 昇格 / ロールバック、反復ごとのレビューと失敗再注入を伴う長時間自律タスクループ
- **Autonomy Layer & Autonomous Mode** *(v1.1.0)* — 横断的な Autonomy Layer が 7 つの能力（perception / cognition / decision / execution / learning / adaptation / monitoring）を metrics collection と E2E acceptance で統合。さらに完全な Autonomous Mode により、Agent は人間の介入なしにタスクを end-to-end で完遂できる。3 つの defense layers（CLAUDE.md 憲法的オーバーライド / Supervisor 明確化バイパス / RLHF ターン終了礼儀）と 4 つの hard brakes（破壊的コマンド / ターン制限 / トークン制限 / ループ検出）を網羅
- **Agent-as-a-Service (PaaS)** — DB 支えの Agent 定義をテナントをまたぎ作成・バージョン管理・マウント・共有・インストール、ユーザー別クォータ、管理者レビュー、公開可能なテンプレートマーケットプレース
- **マルチユーザー分離** — ユーザーごとのワークスペース、ユーザーごとの IM チャンネル、RBAC 権限体系、招待コード登録、監査ログ
- **8 チャンネル統合ルーティング** — Feishu、Telegram、QQ、DingTalk、WeChat、Discord、WhatsApp、Web インターフェースを一様にルーティング
- **マルチエンジン & マルチプロバイダ** — 差し替え可能なコードエージェントエンジン（Claude Code / AtomCode / Codex / OpenCode）と、3 戦略（round-robin / weighted / failover）による複数 Claude API プロバイダ、自動ヘルス検出
- **サンドボックスコード実行** — Docker + seccomp + cgroups で硬化されたサンドボックス、Python / Node / シェルコード実行と Chromium CDP ブラウザ自動化
- **課金と利用統計** — 完全な課金システム（サブスクリプション、ウォレット、引き換えコード）、モデル別トークン追跡とグラフ可視化
- **モバイル PWA** — モバイル特化、ワンクリックでホーム画面にインストール、iOS / Android 両対応
- **国際化** — 29 言語の UI（ネイティブエンドニムと RTL 対応）、Agent はユーザー選択言語で応答

## 機能ショーケース

DeepThink のコア機能をビジュアルで紹介 —— 各画面がどのようなものか、ユーザーにどんな価値をもたらすかをご覧ください。

| スクリーンショット | 機能 | コアハイライト | ユーザーにとっての意味 |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **メインワークスペース** | 複数会話タブ、ストリーミング Markdown、リアルタイム思考パネル、ツール呼び出しトレース | 一つのワークスペースで複数の並行チャットを管理 —— コンテキストを切り替えても状態を失わず、Agent の思考と実行をライブで観察 |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | カスタム Agent 定義の作成 / バージョン管理 / マウント、ホスト能力のプレフライト、スナップショット管理 | 独自の専門 Agent（code-reviewer、web-researcher…）を定義し、すべてのセッションで再利用 |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Agent エディター** | Web UI から `~/.claude/agents/*.md` を編集、システムプロンプト + ツール + サブ Agent を一つのフォームに | 自然言語で Agent の挙動を調整 —— ファイルを掘り下げず、変更は次回セッションから反映 |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Agent テスト** | 公開前にサンプル入力で Agent を実行、完全な出力トレースを検査 | 自信を持って Agent をリリース —— 本番投入前にテストケースで挙動を検証 |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **マルチエンジン** | プラグイン可能なエンジン（Claude Code / AtomCode / Codex / OpenCode）、統合された可用性ダッシュボード | タスクごとに最適な頭脳を選択 —— プラットフォームを再構築せずセッション単位でエンジン切替 |
| <img src="static/deep-think-engine-config.png" width="280" /> | **エンジン設定** | エンジン別のデーモンライフサイクル、プロバイダー認証情報、健全性ステータスを一望 | 複数のプロバイダーを並行稼働 —— 認証情報追加、生存監視、自動フェイルオーバー |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **AtomCode エンジン** | 独立した HTTP/SSE デーモン、agent-runner ごとのループバックポート、自動ティアダウン | AtomCode を代替コーディングエンジンとして使用 —— プロセスごとに独立デーモン、ポート競合なし |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | 管理者発行テンプレート（agent / mcp / skill / kb）、閲覧・評価・ワンクリックインストール | アプリストアのように共有 Agent やツールを発見・インストール —— 管理者がキュレーション、ユーザーはワンクリックで導入 |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | ワークスペース単位の stdio + HTTP MCP Servers、グローバル設定から独立 | 各ワークスペースに独自のツールセットを —— Notion、GitHub、データベース…をそのプロジェクト範囲に限定して接続 |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | プロジェクト / ユーザー / ワークスペースレベルの Skills、ボリュームマウント + シンボリックリンクで自動発見 | プロジェクト単位で Agent に新しい技を教える —— イメージ再ビルド不要、次回セッションから出現 |
| <img src="static/deep-think-memory.png" width="280" /> | **メモリーシステム** | ユーザーグローバル / セッション / 日付メモリー、全文検索、オンライン編集 | Agent がセッションをまたいであなたを記憶 —— 嗜好、プロジェクト文脈、意思決定を再説明なしで呼び戻し |
| <img src="static/deep-think-cron-task.png" width="280" /> | **スケジュールタスク** | Cron / インターバル / 一回限り、Agent またはスクリプト実行、グループまたは隔離コンテキスト、完了時に IM 通知 | 定期作業を自動化 —— 夜次レポート、定期チェック、自律走行ループ、完了時に飛書/Telegram で通知 |
| <img src="static/deep-think-sandbox.png" width="280" /> | **サンドボックス実行** | Docker + seccomp + cgroups、Python / Node / シェルコード、Chromium CDP ブラウザー自動化 | Agent に信頼できないコードを安全に実行させブラウザーを操作 —— 強化隔離、MCP ツールとして公開 |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **システムモニター** | コンテナ一覧、キュー状態、プロバイダー別のアクティブセッション、ヘルスチェック、ワンクリックイメージビルド | 何が動いているかを正確に把握 —— 停滞コンテナの発見、負荷分散、ブラウザーからイメージ再ビルド |
| <img src="static/deep-think-tokens.png" width="280" /> | **使用量と課金** | モデル別トークン明細（入力 / 出力 / キャッシュ）、USD コスト、棒 + 円グラフ、多次元フィルター | トークンと費用の行き先を把握 —— ユーザー、モデル、期間でスライスし、チームに正確に課金 |
| <img src="static/deep-think-about.png" width="280" /> | **バージョン情報** | バージョン、ビルド情報、プロジェクトリンク、ワンクリック更新チェック | 常に最新を維持 —— ビルドバージョンを確認し、ドキュメント、リポジトリ、更新チャネルへ直接アクセス |

## クイックスタート

### 前提条件

**必須**: [Node.js](https://nodejs.org) >= 20、[Docker](https://www.docker.com/)（コンテナモード用。admin のホストモードのみなら不要）、Claude API キー（Anthropic 公式または互換リレーサービス）。

**オプション**: Feishu エンタープライズアプリクレデンシャル、Telegram Bot Token、QQ Bot クレデンシャル、DingTalk クレデンシャル、WeChat iLink トークン、Discord Bot Token、WhatsApp（初回起動時に QR スキャン） — IM 連携が必要な場合のみ。

> Claude Code CLI を手動でインストールする必要はありません — プロジェクトの Claude Agent SDK 依存に完全な CLI ランタイムが含まれ、`make start` 初回起動時に自動インストールされます。

### インストールと起動

```bash
# 1. リポジトリをクローン
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. ワンコマンド起動（初回は依存インストール + コンパイル）
make start
```

http://localhost:9898 にアクセスし、セットアップウィザードに従ってください：管理者を作成（デフォルトアカウントなし）、Claude API を設定、必要に応じて IM チャンネルを設定。設定は全て Web インターフェースから行い、設定ファイルは不要。API キーは AES-256-GCM で暗号化保存されます。

### コンテナモードの有効化

admin ユーザーはデフォルトでホストモード（Docker 不要）を使います。コンテナモードが必要な場合（member ユーザーは登録後に自動使用）：

```bash
./container/build.sh
```

新規ユーザー登録後、コンテナモードのメインワークスペース（`home-{userId}`）が自動作成され、追加設定は不要です。

## アーキテクチャ概要


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink は 4 つの独立した Node.js プロジェクトで構成されます:

- **バックエンド**（Node.js 22 + TypeScript 5.9 + Hono）: メッセージルーター（2s ポーリング + 重複除去）、並行キュー（最大 20 コンテナ + 5 ホストプロセス）、タスクスケジューラ（cron / interval / once）、リアルタイムストリーミングとターミナル用 WebSocket サーバー、bcrypt + HMAC Cookie 認証、RBAC、AES-256-GCM 暗号化設定管理。データは SQLite（WAL モード、スキーマ v1→v51）。Harness / Loop Engineering、Agent-as-a-Service (PaaS)、Sandbox、Claude Code Plugins レイヤーも含みます。
- **フロントエンド**（`web/`）: React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA。react-markdown、mermaid、recharts、xterm.js、モバイル PWA を同梱。
- **Agent Runner**（`container/agent-runner/`）: Docker コンテナ内またはホストプロセスとして動く実行エンジン。Claude Agent SDK の `query()` を呼び、30 種類以上の StreamEvent を stdout に送出し、アトミック書き込みのファイル IPC を介して 27 個の MCP ツールを親プロセスに提供します。
- **デスクトップ**（`desktop/`）: macOS / Windows / Linux 向けの単体アプリをパッケージする Electron シェル。

8 つの IM チャンネル（Feishu、Telegram、QQ、DingTalk、WeChat、Discord、WhatsApp、Web）はルーターに入り、重複除去されてキューに振り分けられ、ProviderPool 経由で API キー / エンジンを選択してコンテナ、ホストプロセス、またはサンドボックスを起動します。ストリーミングイベントは WebSocket で Web クライアントへ、または IM API で各チャンネルへ戻されます。

## 完全なドキュメント

完全なガイドは以下を参照してください:

- [英語完全版](README.md)
- [简体中文 完全版](README.zh-CN.md)

---

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)


## About Author

- [AI光剑的博客](https://blog.csdn.net/universsky2015)

- [Github](https://github.com/AIGeniusInstitue)

- [光剑图书馆: 全球免费开放的电子图书馆 World Free eBook](https://universsky.github.io/)


---

## 捐赠

> Donate to AI Genius Institute:


| 微信                                                    | 支付宝                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| <img src="static/wechat.jpeg" width="300" height="350"> | <img src="static/alipay.jpeg" width="300" height="350"> |

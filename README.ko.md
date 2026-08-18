<details>
<summary><b>🌐 Languages</b></summary>

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

</details>

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  셀프 호스팅 다중 사용자 로컬 AI Agent Loop Engineering 시스템 (데스크톱 + 브라우저 + 모바일) / Powered By AI Genius Institute
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deepthink/releases"><img src="https://img.shields.io/github/v/release/AIGeniusInstitute/deepthink?style=for-the-badge&color=blue&label=Release" alt="Latest Release" /></a>
  <a href="https://github.com/AIGeniusInstitute/deepthink/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/AIGeniusInstitute/deepthink/release.yml?branch=main&style=for-the-badge&label=Build" alt="Build Status" /></a>
  <a href="https://github.com/AIGeniusInstitute/deepthink/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deepthink?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

---

<p align="center">
  <img src="static/deep-think-intro.gif" alt="DeepThink Intro" width="800" />
</p>


## DeepThink란

DeepThink, 엔터프라이즈급 자율형 Agent 자가진화 슈퍼인텔리전스 플랫폼, Harness Engineering에서 Loop Engineering 패러다임으로의 전환을 선도하는 개척자, 기업 고객을 위한 차세대 AI 인프라(AI Infra)입니다. DeepThink 플랫폼은 멀티-Agent 협업 프레임워크를 중심으로 AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, Human-Agent Symbiosis를 융합하여 지속적으로 학습하고 자기 개선하며 궁극적으로 슈퍼인텔리전스로 성장하는 엔터프라이즈급 AI 시스템을 구축합니다:

- **AI 자율 R&D 플랫폼** — Agent가 소프트웨어 개발의 전체 라이프사이클을 독립적으로 완수하며, 루틴한 코딩 작업에 인간 엔지니어의 개입이 불필요합니다
- **자가진화 Agent 엔진** — Agent는 오류로부터 지속적으로 학습하고, 코드베이스에서 지식을 흡수하며, 사용자 피드백으로부터 진화합니다
- **프로그래머-Agent 협업 허브** — 모든 프로그래머는 여러 병렬 세션을 포함하는 개인 "개발 프로젝트"를 소유하며, 중앙 스케줄러가 동시성 충돌을 방지합니다
- **엔터프라이즈 SaaS 플랫폼** — 멀티테넌트 격리, 계층적 권한, 탄력적 과금, 기업 통합(Feishu/DingTalk/WeCom/LDAP)
- **슈퍼인텔리전스 인큐베이터** — 지속적 진화를 통해 단일 Agent는 궁극적으로 완전한 소프트웨어 팀의 종합적 역량을 갖추게 됩니다

> "모든 기업이 결코 멈추지 않고 지속적으로 진화하는 AI 슈퍼 R&D 팀을 소유하기를 — 도구 사용자에서, 코드 창조자로, 궁극적으로 자가 복제하는 슈퍼인텔리전스로 성장하며. AGI를 향한 길에서 함께 걸어갑시다."

### 주요 특징

- **네이티브 Claude Code 구동** — Claude Agent SDK 기반, 내부에 완전한 Claude Code CLI 런타임을 포함해 모든 능력을 계승
- **Harness & Loop Engineering** — 버전 관리되는 harness 매니페스트(시스템 프롬프트 / 서브에이전트 / 도구 / 스킬)로 스냅샷 / diff / eval / 승급 / 롤백 지원, 그리고 반복별 리뷰와 실패 재주입이 가능한 장기 실행 자율 작업 루프
- **Autonomy Layer & Autonomous Mode** *(v1.1.0)* — 횡단적 Autonomy Layer 가 7가지 역량(perception / cognition / decision / execution / learning / adaptation / monitoring)을 metrics collection 과 E2E acceptance 로 통합. 추가로 완전한 Autonomous Mode 가 Agent 가 사람의 개입 없이 작업을 end-to-end 완수하도록 하며, 3개의 defense layers (CLAUDE.md 헌법적 오버라이드 / Supervisor 명확화 우회 / RLHF 턴 종료 정중함) 와 4개의 hard brakes (파괴적 명령 / 턴 한도 / 토큰 한도 / 루프 탐지)를 포함
- **Agent-as-a-Service (PaaS)** — DB 기반 Agent 정의를 생성·버전·마운트·공유·설치, 테넌트 간 공유, 사용자별 할당량·관리자 리뷰·게시 가능한 템플릿 마켓플레이스
- **다중 사용자 격리** — 사용자별 워크스페이스, 사용자별 IM 채널, RBAC 권한 체계, 초대 코드 가입, 감사 로그
- **8채널 통합 라우팅** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, 웹 인터페이스를 동일하게 라우팅
- **멀티 엔진 & 멀티 프로바이더** — 플러그형 코드 에이전트 엔진(Claude Code / AtomCode / Codex / OpenCode)과 다수의 Claude API 프로바이더, 3가지 로드밸런싱 전략(round-robin / weighted / failover), 자동 헬스 탐지
- **샌드박스 코드 실행** — Docker + seccomp + cgroups 강화 샌드박스에서 Python / Node / 셸 코드 실행 및 Chromium CDP 브라우저 자동화
- **결제 및 사용 통계** — 완전한 결제 시스템(구독 플랜, 지갑 잔액, 상환 코드), 모델별 토큰 사용량 추적, 차트 시각화
- **모바일 PWA** — 모바일에 깊게 최적화, 원탭 홈 화면 설치, iOS/Android 대응
- **국제화** — 29종 UI 언어와 네이티브 고유명칭 및 RTL 지원, Agent가 사용자가 선택한 언어로 응답

## 기능 쇼케이스

DeepThink 핵심 기능의 시각 안내 — 각 화면이 어떤 모습인지, 사용자에게 어떤 가치를 전달하는지 확인하세요.

| 스크린샷 | 기능 | 핵심 하이라이트 | 사용자에게 주는 의미 |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **메인 워크스페이스** | 다중 대화 탭, 스트리밍 Markdown, 실시간 사고 패널, 도구 호출 추적 | 하나의 워크스페이스에 여러 병렬 채팅을 담습니다 — 상태를 잃지 않고 컨텍스트 전환, Agent의 사고와 실행을 라이브로 관찰 |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | 커스텀 Agent 정의 생성 / 버전 관리 / 마운트, 호스트 역량 사전 점검, 스냅샷 관리 | 전문 Agent(code-reviewer, web-researcher…)를 정의해 모든 세션에서 재사용 |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Agent 에디터** | Web UI에서 `~/.claude/agents/*.md` 편집, 시스템 프롬프트 + 도구 + 서브 Agent를 한 폼에 | 자연어로 Agent 동작을 조정 — 파일을 뒤질 필요 없이, 변경 사항은 다음 세션에 적용 |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Agent 테스트** | 게시 전 샘플 입력으로 Agent 실행, 전체 출력 트레이스 검사 | 자신감 있게 Agent 출시 — 실전 투입 전 테스트 케이스로 동작을 검증 |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **멀티 엔진** | 플러그형 엔진(Claude Code / AtomCode / Codex / OpenCode), 통합 가용성 대시보드 | 작업마다 최적의 두뇌 선택 — 플랫폼 재설계 없이 세션 단위로 엔진 전환 |
| <img src="static/deep-think-engine-config.png" width="280" /> | **엔진 설정** | 엔진별 데몬 라이프사이클, 프로바이더 자격 증명, 건강 상태를 한눈에 | 여러 프로바이더를 병렬 실행 — 자격 증명 추가, 생존 모니터링, 자동 페일오버 |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **AtomCode 엔진** | 독립형 HTTP/SSE 데몬, agent-runner별 루프백 포트, 자동 해체 | AtomCode를 대체 코딩 엔진으로 사용 — 프로세스마다 독립 데몬, 포트 충돌 없음 |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | 관리자 발행 템플릿(agent / mcp / skill / kb), 탐색·평가·원클릭 설치 | 앱스토어처럼 공유 Agent와 도구를 발견하고 설치 — 관리자가 큐레이션, 사용자는 원클릭 설치 |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | 워크스페이스별 stdio + HTTP MCP Servers, 글로벌 설정과 독립 | 각 워크스페이스에 자체 도구 세트 부여 — Notion, GitHub, 데이터베이스…를 해당 프로젝트 범위로 한정해 연결 |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | 프로젝트 / 사용자 / 워크스페이스 수준 Skills, 볼륨 마운트 + 심볼릭 링크로 자동 발견 | 프로젝트별로 Agent에게 새 기술 가르치기 — 이미지 재빌드 없이 다음 세션에 등장 |
| <img src="static/deep-think-memory.png" width="280" /> | **메모리 시스템** | 사용자 글로벌 / 세션 / 날짜 메모리, 전문 검색, 온라인 편집 | Agent가 세션을 넘어 사용자를 기억 — 취향, 프로젝트 맥락, 결정을 재설명 없이 회상 |
| <img src="static/deep-think-cron-task.png" width="280" /> | **예약 작업** | Cron / 간격 / 일회성, Agent 또는 스크립트 실행, 그룹 또는 격리 컨텍스트, 완료 시 IM 알림 | 반복 작업 자동화 — 야간 보고, 주기적 점검, 자율 실행 루프, 완료 시 비호/Telegram으로 알림 |
| <img src="static/deep-think-sandbox.png" width="280" /> | **샌드박스 실행** | Docker + seccomp + cgroups, Python / Node / 셸 코드, Chromium CDP 브라우저 자동화 | Agent가 신뢰할 수 없는 코드를 안전하게 실행하고 브라우저를 구동 — 강화된 격리, MCP 도구로 노출 |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **시스템 모니터** | 컨테이너 목록, 큐 상태, 프로바이더별 활성 세션, 헬스 체크, 원클릭 이미지 빌드 | 무엇이 돌아가고 있는지 정확히 파악 — 멈춘 컨테이너 발견, 부하 분산, 브라우저에서 이미지 재빌드 |
| <img src="static/deep-think-tokens.png" width="280" /> | **사용량 및 과금** | 모델별 토큰 분해(입력 / 출력 / 캐시), USD 비용, 막대 + 파이 차트, 다차원 필터 | 토큰과 비용이 어디로 가는지 파악 — 사용자, 모델, 기간으로 분석해 팀에 정확히 과금 |
| <img src="static/deep-think-about.png" width="280" /> | **정보** | 버전, 빌드 정보, 프로젝트 링크, 원클릭 업데이트 확인 | 항상 최신 유지 — 빌드 버전을 확인하고 문서, 저장소, 업데이트 채널로 바로 이동 |

## 빠른 시작

### 사전 조건

**필수**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/)(컨테이너 모드용. admin 호스트 모드만 사용하면 불필요), Claude API 키(Anthropic 공식 또는 호환 릴레이 서비스).

**선택**: Feishu 엔터프라이즈 앱 자격증명, Telegram Bot Token, QQ Bot 자격증명, DingTalk 자격증명, WeChat iLink 토큰, Discord Bot Token, WhatsApp(첫 실행 시 QR 스캔) — IM 연동이 필요한 경우만.

> Claude Code CLI를 수동으로 설치할 필요가 없습니다 — 프로젝트의 Claude Agent SDK 의존성에 완전한 CLI 런타임이 포함되어 있으며, 첫 `make start` 실행 시 자동 설치됩니다.

### 설치 및 실행

```bash
# 1. 리포지토리 클론
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. 원커맨드 실행(첫 실행 시 의존성 설치 + 컴파일)
make start
```

http://localhost:9898 에 접속해 셋업 마법사를 따르세요: 관리자 생성(기본 계정 없음), Claude API 설정, 필요 시 IM 채널 설정. 모든 설정은 웹 인터페이스에서 처리하며 별도의 설정 파일은 필요 없습니다. API 키는 AES-256-GCM으로 암호화되어 저장됩니다.

### 컨테이너 모드 활성화

admin 사용자는 기본적으로 호스트 모드(Docker 불필요)를 사용합니다. 컨테이너 모드는 member 사용자에게 필요하며 가입 후 자동 활성화됩니다:

```bash
./container/build.sh
```

신규 사용자 가입 후 컨테이너 모드의 메인 워크스페이스(`home-{userId}`)가 자동 생성되며, 추가 설정은 필요 없습니다.

## 아키텍처 개요


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink는 네 개의 독립적인 Node.js 프로젝트로 구성됩니다:

- **백엔드**(Node.js 22 + TypeScript 5.9 + Hono): 메시지 라우터(2초 폴링 + 중복 제거), 동시성 큐(최대 20 컨테이너 + 5 호스트 프로세스), 작업 스케줄러(cron / interval / once), 실시간 스트리밍과 터미널용 WebSocket 서버, bcrypt + HMAC Cookie 인증, RBAC, AES-256-GCM 암호화 설정 관리. SQLite 영속화(WAL 모드, 스키마 v1→v51). 또한 Harness / Loop Engineering, Agent-as-a-Service (PaaS), 샌드박스, Claude Code Plugins 계층을 포함합니다.
- **프론트엔드**(`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, react-markdown, mermaid, recharts, xterm.js, 모바일 PWA 포함.
- **Agent Runner**(`container/agent-runner/`): Docker 컨테이너 또는 호스트 프로세스로 동작하는 실행 엔진. Claude Agent SDK의 `query()`를 호출하고, 30종 이상의 StreamEvent를 stdout으로 내보내며, 원자적 쓰기 파일 IPC를 통해 27개의 MCP 도구를 부모 프로세스에 제공합니다.
- **데스크톱**(`desktop/`): macOS / Windows / Linux용 단독 앱으로 패키징하는 Electron 셸.

여덟 IM 채널(Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, 웹)은 라우터로 진입해 중복 제거 후 큐로 분배되고, 프로바이더 풀이 API 키 / 엔진을 선택해 컨테이너, 호스트 프로세스 또는 샌드박스를 기동합니다. 스트리밍 이벤트는 WebSocket으로 웹 클라이언트에 브로드캐스트되거나 IM API로 각 채널에 회신됩니다.

## 전체 문서

전체 가이드는 아래를 참고하세요:

- [영어 전체 버전](README.md)
- [简体中文 전체 버전](README.zh-CN.md)

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

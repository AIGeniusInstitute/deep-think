**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistema self-hosted multi-utente di AI Agent Loop Engineering locale (desktop + browser + mobile) / Powered By AI Genius Institute
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


## Cos'è DeepThink

DeepThink, una piattaforma di auto-evoluzione della superintelligenza Agent autonoma di livello enterprise, pioniera nella transizione dal paradigma Harness Engineering al Loop Engineering, è la nuova generazione di Infrastruttura AI (AI Infra) per clienti enterprise. La piattaforma DeepThink si centra su un framework di collaborazione multi-Agent, fondendo AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop e Human-Agent Symbiosis per costruire un sistema AI di livello enterprise che apprende continuamente, si auto-migliora e infine cresce fino a diventare una superintelligenza:

- **Piattaforma R&D Autonoma AI** — Gli Agent completano indipendentemente l'intero ciclo di vita dello sviluppo software, senza bisogno di ingegneri umani per le attività di codifica routinaria
- **Motore Agent Auto-Evolvente** — Gli Agent apprendono continuamente dagli errori, assorbono conoscenza dalla codebase e si evolvono dal feedback degli utenti
- **Hub di Collaborazione Programmatore-Agent** — Ogni programmatore possiede un "Progetto di Sviluppo" personale con multiple sessioni parallele, e uno scheduler centrale previene conflitti di concorrenza
- **Piattaforma SaaS Enterprise** — Isolamento multi-tenant, permessi a livelli, fatturazione elastica e integrazioni enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Incubatore di Superintelligenza** — Attraverso evoluzione continua, un singolo Agent infine acquisisce le capacità comprehensive di un team software completo

> "Che ogni enterprise possegga un team R&D super AI che non si ferma mai e si evolve continuamente — da utente di strumenti, a creatore di codice, crescendo infine in una superintelligenza auto-replicante. Camminiamo insieme sulla via verso l'AGI."

### Caratteristiche principali

- **Motore Claude Code nativo** — basato su Claude Agent SDK, con il runtime CLI completo di Claude Code sottostante, eredita tutte le sue capacità
- **Harness & Loop Engineering** — manifest di harness versionati (system prompt / subagents / tools / skills) con snapshot / diff / eval / promote / rollback, più loop di task autonomi a lungo termine con revisione per-iterazione e re-injection dei fallimenti
- **Agent-as-a-Service (PaaS)** — definizioni di Agent DB-backed: creazione, versionamento, mount, condivisione e installazione tra tenant, con quote per utente, revisione admin e marketplace di template pubblicabili
- **Isolamento multi-utente** — workspace per utente, canali IM per utente, sistema di permessi RBAC, registrazione con codice invito, log di audit
- **Routing unificato su otto canali** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp e interfaccia web, tutti instradati in modo uniforme
- **Multi-Engine e Multi-Provider** — motori pluggabili di code-agent (Claude Code / AtomCode / Codex / OpenCode) e più provider Claude API con tre strategie di load balancing (round-robin / weighted / failover), health detection automatico
- **Esecuzione di codice sandboxed** — sandbox indurita Docker + seccomp + cgroups per esecuzione di codice Python / Node / shell e automazione browser Chromium CDP
- **Billing e statistiche di utilizzo** — billing completo (abbonamento, wallet, codici di riscossione), tracciamento dei token per modello con grafici
- **PWA mobile** — ottimizzata per mobile, installazione sulla schermata home con un clic, sia iOS che Android
- **Internazionalizzata** — 29 lingue UI con endonimi nativi e supporto RTL; l'Agent risponde nella lingua scelta dall'utente

## Vetrina delle funzionalità

Una panoramica visiva delle capacità chiave di DeepThink — l'aspetto di ogni schermata e il valore che porta all'utente.

| Screenshot | Funzionalità | Caratteristiche chiave | Cosa significa per te |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Workspace principale** | Tab multi-conversazione, Markdown in streaming, pannello di ragionamento in tempo reale, tracciatura delle chiamate agli strumenti | Un unico workspace contiene molte chat in parallelo — cambi contesto senza perdere stato, guardi l'Agent pensare e agire in diretta |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Crea / versiona / monta definizioni di Agent personalizzate, preflight delle capacità del host, gestione snapshot | Definisci i tuoi Agent specializzati (code-reviewer, web-researcher, …) e riutilizzali in ogni sessione |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Editor di Agent** | Modifica `~/.claude/agents/*.md` dalla Web UI, system-prompt + strumenti + subagent in un unico form | Regola il comportamento di un Agent in linguaggio chiaro — niente scartabellare file, le modifiche si applicano alla prossima sessione |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Test Agent** | Esegui un Agent su input di esempio prima di pubblicarlo, ispeziona la traccia completa di output | Rilascia Agent con sicurezza — verifica il comportamento sui casi di test prima di lasciarli in produzione |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Multi-Engine** | Motori pluggable (Claude Code / AtomCode / Codex / OpenCode), dashboard unificata di disponibilità | Scegli il cervello migliore per ogni task — cambi motore per sessione senza ri-architettare la piattaforma |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Configurazione motore** | Lifecycle del daemon per motore, credenziali del provider, stato di salute a colpo d'occhio | Esegui più provider fianco a fianco — aggiungi credenziali, monitora la disponibilità e fai failover automatico |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Motore AtomCode** | Daemon HTTP/SSE autonomo, porta loopback per agent-runner, auto-teardown | Usa AtomCode come motore di codifica alternativo — daemon isolato per processo, nessun conflitto di porte |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Template pubblicabili dall'admin (agent / mcp / skill / kb), sfoglia, valuta, installazione con un clic | Scopri e installa Agent e strumenti condivisi come in un app store — gli admin curano, gli utenti installano con un clic |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **Server MCP** | Server MCP stdio + HTTP per workspace, indipendenti dalla configurazione globale | Dai a ogni workspace il proprio set di strumenti — connetti Notion, GitHub, database… exactly limitati a quel progetto |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills a livello progetto / utente / workspace, auto-scoperte tramite volume mount + symlink | Insegna all'Agent nuovi trucchi per progetto — nessun rebuild dell'immagine, le skills appaiono nella prossima sessione |
| <img src="static/deep-think-memory.png" width="280" /> | **Sistema di memoria** | Memoria utente globale / di sessione / per data, ricerca full-text, modifica online | L'Agent si ricorda di te tra le sessioni — recupera preferenze, contesto di progetto e decisioni senza doverle rispiegare |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Attività pianificate** | Cron / intervallo / una sola volta, esecuzione Agent o Script, contesto di gruppo o isolato, notifica IM al completamento | Automatizza il lavoro ricorrente — report notturni, controlli periodici, loop autonomi che ti pingano su Feishu/Telegram a lavoro finito |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Esecuzione in Sandbox** | Docker + seccomp + cgroups, codice Python / Node / shell, automazione browser via Chromium CDP | Lascia che l'Agent esegua codice non attendibile e guidi un browser in sicurezza — isolamento rafforzato, esposto come strumenti MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Monitor di sistema** | Lista container, stato della coda, sessioni attive per provider, health check, build dell'immagine con un clic | Vedi esattamente cosa sta girando — individua container bloccati, bilancia il carico e ricostruisci le immagini dal browser |
| <img src="static/deep-think-tokens.png" width="280" /> | **Usage e fatturazione** | Breakdown dei token per modello (input / output / cache), costo in USD, grafici a barre + torta, filtri multidimensionali | Sai dove vanno i tuoi token e i tuoi soldi — filtra per utente, modello e intervallo, fattura i team con precisione |
| <img src="static/deep-think-about.png" width="280" /> | **Informazioni** | Versione, info di build, link del progetto, verifica aggiornamenti con un clic | Rimani aggiornato — vedi la tua versione di build e salta direttamente a docs, repo e canali di aggiornamento |

## Avvio rapido

### Prerequisiti

**Obbligatori**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (per la modalità container; non necessario per la modalità host dell'admin), chiave Claude API (Anthropic ufficiale o servizio relay compatibile).

**Opzionali**: credenziali dell'app enterprise Feishu, Telegram Bot Token, credenziali QQ Bot, credenziali DingTalk, token WeChat iLink, Discord Bot Token, WhatsApp (scansione QR al primo avvio) — solo se serve l'integrazione IM.

> Non è necessario installare manualmente la CLI di Claude Code — la dipendenza del progetto da Claude Agent SDK include il runtime CLI completo, installato automaticamente al primo `make start`.

### Installazione e avvio

```bash
# 1. Clona il repository
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Avvio con un solo comando (alla prima esecuzione installa dipendenze + compila)
make start
```

Apri http://localhost:9898 e segui la procedura guidata: crea un amministratore (nessun account predefinito), configura la Claude API e, se necessario, i canali IM. Tutto si configura dall'interfaccia web, niente file di configurazione. Le chiavi API sono crittografate con AES-256-GCM.

### Attivazione della modalità container

L'utente admin usa in modalità predefinita la modalità host (senza Docker). La modalità container è necessaria per gli utenti member (si attiva automaticamente dopo la registrazione):

```bash
./container/build.sh
```

Dopo la registrazione di un nuovo utente, il workspace principale in modalità container (`home-{userId}`) viene creato automaticamente, senza configurazione aggiuntiva.

## Panoramica dell'architettura


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink è composto da quattro progetti Node.js indipendenti:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): router dei messaggi (polling 2s + deduplicazione), coda concorrente (massimo 20 container + 5 processi host), pianificatore di task (cron / interval / once), server WebSocket per streaming in tempo reale e terminale, autenticazione bcrypt + HMAC Cookie, RBAC, gestione configurazione crittografata AES-256-GCM. Persistenza in SQLite (modalità WAL, schema v1→v51). Include anche i layer Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox e Claude Code Plugins.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, con react-markdown, mermaid, recharts, xterm.js, PWA mobile.
- **Agent Runner** (`container/agent-runner/`): motore di esecuzione in container Docker o come processo host; chiama `query()` di Claude Agent SDK, emette oltre 30 tipi di StreamEvent via stdout e offre 27 strumenti MCP al processo padre su canali IPC basati su file con scritture atomiche.
- **Desktop** (`desktop/`): shell Electron che packages un'app standalone per macOS / Windows / Linux.

Gli otto canali IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) entrano nel router, vengono deduplicati e instradati alla coda, che seleziona una chiave API / engine tramite il provider pool e avvia un container, un processo host o un sandbox. Gli eventi di streaming sono trasmessi via WebSocket ai client web o risposti via IM API a ciascun canale.

## Documentazione completa

La guida completa è disponibile qui:

- [Versione completa in inglese](README.md)
- [Versione completa 简体中文](README.zh-CN.md)

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

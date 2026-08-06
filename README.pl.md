**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Samohostowany wieloużytkownikowy lokalny system AI Agent Loop Engineering (desktop + przeglądarka + mobilne) / Powered By AI Genius Institute
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


## Czym jest DeepThink

DeepThink, platforma samoewolucji superinteligencji Agent autonomicznej klasy enterprise, pionier w przejściu od paradygmatu Harness Engineering do Loop Engineering, to nowe pokolenie Infrastruktury AI (AI Infra) dla klientów enterprise. Platforma DeepThink skupia się na frameworku współpracy wielo-Agentowej, łącząc AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop oraz Human-Agent Symbiosis, aby zbudować system AI klasy enterprise, który stale się uczy, samodzielnie się poprawia i ostatecznie wzrasta do rangi superinteligencji:

- **Platforma Autonomicznego R&D AI** — Agent-y samodzielnie przechodzą pełny cykl życia tworzenia oprogramowania, eliminując potrzebę inżynierów ludzkich przy rutynowych zadaniach kodowania
- **Silnik Agent Samoewolucyjny** — Agent-y stale uczą się na błędach, absorbują wiedzę z bazy kodu i ewoluują na podstawie opinii użytkowników
- **Centrum Współpracy Programista-Agent** — Każdy programista posiada osobisty „Projekt Rozwoju" zawierający wiele równoległych sesji, a centralny scheduler zapobiega konfliktom współbieżności
- **Platforma SaaS Enterprise** — Izolacja multi-tenant, uprawnienia hierarchiczne, elastyczne fakturowanie i integracje enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Inkubator Superinteligencji** — Poprzez ciągłą ewolucję, pojedynczy Agent ostatecznie uzyskuje wyczerpujące zdolności pełnego zespołu programistycznego

> „Niech każde przedsiębiorstwo posiada zespół R&D super AI, który nigdy nie ustaje i stale się rozwija — od użytkownika narzędzi, do twórcy kodu, ostatecznie wzrastając do samo-replikującej się superinteligencji. Kroczmy razem na drodze do AGI."

### Główne cechy

- **Natywny silnik Claude Code** — Zbudowany na Claude Agent SDK, z pełnym runtime Claude Code CLI pod spodem, dziedziczy wszystkie jego możliwości
- **Harness & Loop Engineering** — Wersjonowane manifesty harness (system prompt / subagenty / narzędzia / umiejętności) z snapshot / diff / eval / promote / rollback, oraz długotrwałe autonomiczne pętle zadań z przeglądem każdej iteracji i reiniekcją błędów
- **Autonomy Layer i Autonomous Mode** *(v1.1.0)* — Przekrojowa Autonomy Layer jednoczy 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) z metrics collection i E2E acceptance; plus pełny Autonomous Mode pozwalający Agentowi ukończyć zadanie end-to-end bez ludzkiego prowadzenia, pokrywając three defense layers (CLAUDE.md nadpisanie konstytucyjne / Supervisor pominięcie doprecyzowania / RLHF uprzejmość końca tury) i four hard brakes (destrukcyjne polecenia / limit tur / limit tokenów / wykrywanie pętli)
- **Agent-as-a-Service (PaaS)** — Tworzenie, wersjonowanie, montowanie, współdzielenie i instalowanie definicji Agentów opartych na bazie danych między tenantami, z limitami per użytkownik, przeglądem administratora i publikowalnym marketplace szablonów
- **Izolacja wielu użytkowników** — Workspace per użytkownik, kanały IM per użytkownik, system uprawnień RBAC, rejestracja kodem zaproszenia, dzienniki audytu
- **Jednolity routing ośmiu kanałów** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp i interfejs web — wszystko kierowane jednorodnie
- **Wiele silników i wielu providerów** — Plug-inowe silniki agenta kodu (Claude Code / AtomCode / Codex / OpenCode) oraz wielu providerów Claude API z trzema strategiami load balancingu (round-robin / weighted / failover), automatyczne wykrywanie zdrowia
- **Piaskownica wykonywania kodu** — Sandbox wzmacniany Docker + seccomp + cgroups do wykonywania kodu Python / Node / shell oraz automatyzacji przeglądarki Chromium CDP
- **Billing i statystyki użycia** — Pełny system billingu (plany subskrypcyjne, saldo portfela, kody wymiany), śledzenie użycia tokenów per model z wizualizacjami wykresów
- **Mobilne PWA** — Głęboko zoptymalizowane na mobilne, instalacja na ekranie głównym jednym kliknięciem, obsługa iOS / Android
- **Zinternacjonalizowane** — 29 języków UI z rodzimymi endonimami i obsługą RTL; Agent odpowiada w wybranym przez użytkownika języku

## Przegląd funkcji

Wizualny przegląd kluczowych możliwości DeepThink — jak wygląda każdy ekran i jaką wartość daje użytkownikowi.

| Zrzut ekranu | Funkcja | Najważniejsze cechy | Co to oznacza dla Ciebie |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Główny obszar roboczy** | Zakładki z wieloma rozmowami, streaming Markdown, panel myślenia w czasie rzeczywistym, śledzenie wywołań narzędzi | Jedna przestrzeń pracy mieści wiele równoległych czatów — przełączaj kontekst bez utraty stanu i obserwuj, jak Agent myśli i działa na żywo |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Tworzenie / wersjonowanie / montaż własnych definicji Agent, weryfikacja możliwości hosta, zarządzanie snapshotami | Definiuj własnych specjalistycznych Agent (code-reviewer, web-researcher, …) i używaj ich w każdej sesji |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Edytor Agent** | Edycja `~/.claude/agents/*.md` z Web UI, prompt systemowy + narzędzia + subagenci w jednym formularzu | Dostosowuj zachowanie Agent w prostym języku — bez grzebania w plikach, zmiany działają od następnej sesji |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Testowanie Agent** | Uruchomienie Agent na próbkach wejściowych przed publikacją, podgląd pełnego wyjścia | Wypuszczaj Agent z pewnością — weryfikuj zachowanie na testach przed wypuszczeniem do produkcji |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Wielosilnikowy** | Wtyczne silniki (Claude Code / AtomCode / Codex / OpenCode), ujednolicony panel dostępności | Wybieraj najlepszy „mózg” do każdego zadania — przełączaj silniki per sesja bez przebudowy platformy |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Konfiguracja silnika** | Cykl życia demona per silnik, poświadczenia providera, stan zdrowia w jednym rzucie oka | Uruchamiaj wielu providerów równolegle — dodawaj poświadczenia, monitoruj dostępność i automatyczny failover |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Silnik AtomCode** | Autonomiczny demon HTTP/SSE, port loopback na każdy agent-runner, auto-demontaż | Używaj AtomCode jako alternatywnego silnika kodowania — izolowany demon na proces, bez konfliktów portów |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Szablony publikowane przez admina (agent / mcp / skill / kb), przeglądanie, oceny, instalacja jednym kliknięciem | Odkrywaj i instaluj współdzielone Agent i narzędzia jak w sklepie z aplikacjami — admin kuratoruje, użytkownicy instalują jednym kliknięciem |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | stdio + HTTP MCP Servers per obszar roboczy, niezależnie od globalnego konfiga | Daj każdej przestrzeni pracy własny zestaw narzędzi — podłączaj Notion, GitHub, bazy danych… scope dokładnie pod projekt |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills poziomu projektu / użytkownika / obszaru roboczego, auto-wykrywanie przez wolumeny i symlinki | Ucz Agent nowych sztuczek per projekt — bez przebudowy obrazu, umiejętności pojawią się w następnej sesji |
| <img src="static/deep-think-memory.png" width="280" /> | **System pamięci** | Pamięć użytkownika-globalna / sesji / wg daty, pełnotekstowe wyszukiwanie, edycja online | Agent pamięta Cię między sesjami — przywołuj preferencje, kontekst projektu i decyzje bez ponownego tłumaczenia |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Zaplanowane zadania** | Cron / interwał / jednorazowe, wykonanie Agent lub skryptu, kontekst grupy lub izolowany, powiadomienie w IM po ukończeniu | Automatyzuj powtarzalną pracę — nocne raporty, okresowe kontrole, samobiegne pętle, które pingują Cię na Feishu/Telegram |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Wykonanie w piaskownicy** | Docker + seccomp + cgroups, kod w Python / Node / shell, automatyzacja przeglądarki Chromium CDP | Pozwól Agent uruchamiać niezaufany kod i sterować przeglądarką bezpiecznie — utwardzona izolacja, dostępne jako narzędzia MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Monitor systemu** | Lista kontenerów, stan kolejki, aktywne sesje per provider, kontrole zdrowia, budowanie obrazu jednym kliknięciem | Widz dokładnie, co działa — dostrzegaj zablokowane kontenery, balansuj obciążenie i przebudowuj obrazy z przeglądarki |
| <img src="static/deep-think-tokens.png" width="280" /> | **Użycie i rozliczenia** | Podział tokenów wg modeli (wejście / wyjście / cache), koszt w USD, wykresy słupkowe i kołowe, wielowymiarowe filtry | Wiedz, gdzie idą tokeny i pieniądze — przekroje wg użytkownika, modelu i zakresu czasu, dokładnie rozliczaj zespoły |
| <img src="static/deep-think-about.png" width="280" /> | **O projekcie** | Wersja, info o buildzie, linki projektu, sprawdzanie aktualizacji jednym kliknięciem | Bądź na bieżąco — widz wersję builda i od razu przechodź do dokumentacji, repozytorium i kanałów aktualizacji |

## Szybki start

### Wymagania wstępne

**Wymagane**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (dla trybu container; niepotrzebny dla trybu host admina), klucz Claude API (oficjalny Anthropic lub kompatybilna usługa relay).

**Opcjonalne**: dane uwierzytelniające aplikacji enterprise Feishu, Telegram Bot Token, dane QQ Bot, dane DingTalk, token WeChat iLink, Discord Bot Token oraz WhatsApp (skanowanie QR przy pierwszym uruchomieniu) — tylko gdy potrzebujesz integracji IM.

> Claude Code CLI nie wymaga ręcznej instalacji — zależność projektu od Claude Agent SDK zawiera pełny runtime CLI, instalowany automatycznie przy pierwszym `make start`.

### Instalacja i uruchomienie

```bash
# 1. Sklonuj repozytorium
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Uruchomienie jednym poleceniem (pierwszy raz instaluje zależności + kompiluje)
make start
```

Otwórz http://localhost:9898 i podążaj za kreatorem konfiguracji: utwórz administratora (brak domyślnego konta), skonfiguruj Claude API i opcjonalnie kanały IM. Wszystko konfiguruje się z interfejsu webowego, bez plików konfiguracyjnych. Klucze API są szyfrowane AES-256-GCM.

### Aktywacja trybu container

Administrator używa domyślnie trybu host (bez Dockera). Tryb container jest wymagany dla użytkowników member (aktywowany automatycznie po rejestracji):

```bash
./container/build.sh
```

Po rejestracji nowego użytkownika główne workspace w trybie container (`home-{userId}`) jest tworzone automatycznie, bez dodatkowej konfiguracji.

## Przegląd architektury


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink składa się z czterech niezależnych projektów Node.js:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): główny serwis z routerem wiadomości (polling 2s + deduplikacja), kolejką współbieżną (maks. 20 kontenerów + 5 procesów hosta), harmonogramem zadań (cron / interval / once), serwerem WebSocket do streamingu w czasie rzeczywistym i terminala, uwierzytelnianiem bcrypt + HMAC Cookie, RBAC oraz szyfrowaną AES-256-GCM konfiguracją. Trwałość w SQLite (tryb WAL, schema v1→v51). Obejmuje również warstwy Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox oraz Claude Code Plugins.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, z react-markdown, mermaid, recharts, xterm.js oraz mobilnym PWA.
- **Agent Runner** (`container/agent-runner/`): silnik wykonawczy działający w kontenerze Docker lub jako proces hosta; wywołuje `query()` z Claude Agent SDK, emituje 30+ typów StreamEvent przez stdout i udostępnia 27 narzędzi MCP procesowi nadrzędnemu przez plikowe kanały IPC z atomowymi zapisami.
- **Desktop** (`desktop/`): powłoka Electron pakująca samodzielną aplikację na macOS / Windows / Linux.

Osiem kanałów IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) trafia do routera, jest deduplikowane i kolejkowane, gdzie ProviderPool wybiera klucz API / silnik i uruchamia kontener, proces hosta lub sandbox. Zdarzenia streamingu są rozgłaszane przez WebSocket do klientów webowych lub odpowiadane przez API IM do każdego kanału.

## Pełna dokumentacja

Pełny przewodnik znajdziesz tutaj:

- [Pełna wersja angielska](README.md)
- [Pełna wersja 简体中文](README.zh-CN.md)

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

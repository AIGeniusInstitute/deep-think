**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Самохостована багатокористувацька локальна система AI Agent Loop Engineering (десктоп + браузер + мобільний) / Powered By AI Genius Institute
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


## Що таке DeepThink

DeepThink — корпоративна платформа самоеволюції автономного Agent-суперінтелекту, піонер переходу від парадигми Harness Engineering до Loop Engineering, нове покоління AI-інфраструктури (AI Infra) для корпоративних клієнтів. Платформа DeepThink побудована навколо фреймворку багато-Agent-взаємодії, поєднуючи AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop та Human-Agent Symbiosis для створення корпоративної AI-системи, що безперервно навчається, самовдосконалюється і зрештою виростає до суперінтелекту:

- **Платформа автономної AI-розробки** — Agent самостійно проходить повний життєвий цикл розробки ПЗ, усуваючи потребу в людях-інженерах для рутинних завдань кодування
- **Движок самоеволюційного Agent** — Agent безперервно вчиться на помилках, поглинає знання з кодової бази та еволюціонує на основі відгуків користувачів
- **Центр співпраці програміста та Agent** — Кожен програміст має особистий «Проєкт розробки» з кількома паралельними сесіями, а центральний планувальник запобігає конфліктам паралелізму
- **Корпоративна SaaS-платформа** — Мультитенантна ізоляція, ієрархічні права, еластичний білінг та корпоративні інтеграції (Feishu/DingTalk/WeCom/LDAP)
- **Інкубатор суперінтелекту** — Через безперервну еволюцію єдиний Agent зрештою здобуває комплексні можливості повноцінної програмної команди

> «Хай кожне підприємство матиме команду AI-супер-R&D, що ніколи не зупиняється й безперервно еволюціонує — від користувача інструментів, до творця коду, зрештою виростаючи в само-репродукційний суперінтелект. Проймо цим шляхом до AGI разом.»

### Ключові можливості

- **Рідний двигун Claude Code** — побудовано на Claude Agent SDK, під капотом повний runtime Claude Code CLI, успадковує всі його можливості
- **Harness та Loop Engineering** — версіоновані harness-маніфести (system prompt / subagents / tools / skills) зі snapshot / diff / eval / promote / rollback, плюс довготривалі автономні цикли завдань з переглядом кожної ітерації та повторним впровадженням помилок
- **Autonomy Layer та Autonomous Mode** *(v1.1.0)* — Наскрізна Autonomy Layer поєднує 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) з metrics collection та E2E acceptance; плюс повний Autonomous Mode, що дозволяє Агенту завершувати завдання end-to-end без людського контролю, покриваючи three defense layers (CLAUDE.md конституційне перевизначення / Supervisor обход уточнення / RLHF ввічливість кінця ходу) та four hard brakes (деструктивні команди / ліміт ходів / ліміт токенів / виявлення циклу)
- **Agent-as-a-Service (PaaS)** — створення, версіонування, монтування, поширення та встановлення збережених у БД визначень Agent між тенантами, з квотами на користувача, адмін-переглядом і публічним marketplace-шаблонів
- **Багатокористувацька ізоляція** — workspace на користувача, IM-канали на користувача, система прав RBAC, реєстрація за кодом запрошення, журнал аудиту
- **Восьмиканальна уніфікована маршрутизація** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp та веб-інтерфейс — усе маршрутизується єдино
- **Багато-двигунна та багатопровайдерна архітектура** — підключаємі двигуни code-agent (Claude Code / AtomCode / Codex / OpenCode) та кілька Claude API-провайдерів із трьома стратегіями балансування (round-robin / weighted / failover), автоматичний health-check
- **Пісочниця виконання коду** — Docker + seccomp + cgroups-посилена пісочниця для виконання Python / Node / shell-коду та Chromium CDP-автоматизації браузера
- **Білінг і статистика використання** — повний білінг (підписки, гаманець, коди погашення), трекінг токенів на модель з графіками
- **Мобільна PWA** — глибока оптимізація під мобільні, встановлення на головний екран одним кліком, адаптація під iOS / Android
- **Інтернаціоналізація** — 29 UI-мов із рідними ендонімами та підтримкою RTL; Agent відповідає мовою, обраною користувачем

## Демонстрація можливостей

Візуальний огляд ключових можливостей DeepThink — як виглядає кожен екран і яку цінність він дає користувачу.

| Скріншот | Функція | Ключові особливості | Що це означає для вас |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Основний робочий простір** | Вкладки з кількома діалогами, потоковий Markdown, панель роздумів у реальному часі, трасування викликів інструментів | В одному робочому просторі — багато паралельних чатів: перемикайте контекст без втрати стану й спостерігайте, як Agent думає та діє наживо |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Створення / версіонування / підключення власних визначень Agent, попередня перевірка можливостей хоста, керування снапшотами | Визначайте власних профільних Agent (code-reviewer, web-researcher, …) і перевикористовуйте їх у кожній сесії |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Редактор Agent** | Редагування `~/.claude/agents/*.md` з Web UI, системний промпт + інструменти + субагенти в одній формі | Налаштовуйте поведінку Agent зрозумілою мовою — без копання у файлах, зміни діють із наступної сесії |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Тестування Agent** | Запуск Agent на тестових входах перед публікацією, перегляд повного виводу | Випускайте Agent упевнено — перевіряйте поведінку на тест-кейсах перед запуском у продакшн |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Мульти-движок** | Підключаємі движки (Claude Code / AtomCode / Codex / OpenCode), єдина панель доступності | Обирайте найкращий «мозок» для кожного завдання — перемикайте движки за сесією без переробки платформи |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Конфігурація движка** | Життєвий цикл демона за движком, облікові дані провайдера, стан здоров'я з одного погляду | Запускайте кілька провайдерів паралельно — додавайте облікові дані, слідкуйте за доступністю та автоматичне відмовостійке перемикання |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Движок AtomCode** | Автономний HTTP/SSE-демон, loopback-порт на кожен agent-runner, авто-демонтаж | Використовуйте AtomCode як альтернативний движок кодингу — ізольований демон на процес, без конфліктів портів |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Шаблони, що публікуються адміністратором (agent / mcp / skill / kb), перегляд, оцінки, встановлення в один клік | Знаходьте й встановлюйте спільні Agent та інструменти як у магазині додатків — адмін курирує, користувачі ставлять одним кліком |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | stdio + HTTP MCP Servers на робочий простір, незалежно від глобального конфіга | Давайте кожному робочому простору свій набір інструментів — підключайте Notion, GitHub, бази даних… скоуп рівно під проєкт |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills рівня проєкту / користувача / робочого простору, авто-виявлення через томи та симлінки | Навчайте Agent новим трюкам по проєкту — без перебудови образа, навички з'являться у наступній сесії |
| <img src="static/deep-think-memory.png" width="280" /> | **Система пам'яті** | Пам'ять користувацька-глобальна / сесії / по даті, повнотекстовий пошук, редагування онлайн | Agent пам'ятає вас між сесіями — згадуйте уподобання, контекст проєкту та рішення без повторних пояснень |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Розклад завдань** | Cron / інтервал / одноразове, виконання Agent або скрипта, контекст групи або ізольований, сповіщення в IM по завершенні | Автоматизуйте повторювану роботу — нічні звіти, періодичні перевірки, самозапускні цикли, що пінгують вас у Feishu/Telegram |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Ізольоване виконання** | Docker + seccomp + cgroups, код на Python / Node / shell, браузерна автоматизація Chromium CDP | Нехай Agent запускає недовірений код і керує браузером безпечно — посилена ізоляція, доступно як MCP-інструменти |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Системний монітор** | Список контейнерів, стан черги, активні сесії по провайдерах, перевірки здоров'я, збірка образу в один клік | Бачите, що саме запущено — помічайте завислі контейнери, балансуйте навантаження та перезбирайте образи з браузера |
| <img src="static/deep-think-tokens.png" width="280" /> | **Використання та білінг** | Деталізація токенів по моделях (вхід / вихід / кеш), вартість в USD, стовпчасті та кругові діаграми, багатовимірні фільтри | Знайте, куди йдуть токени й гроші — зрізи по користувачу, моделі та часовому діапазону, точно білльте команди |
| <img src="static/deep-think-about.png" width="280" /> | **Про проєкт** | Версія, інфо про збірку, посилання проєкту, перевірка оновлень в один клік | Будьте в курсі — дивіться версію збірки й одразу переходьте до документації, репозиторію та каналів оновлень |

## Швидкий старт

### Передумови

**Обов'язково**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (для режиму container; не потрібен для admin host-режиму), Claude API-ключ (офіційний Anthropic або сумісний relay-сервіс).

**Опціонально**: облікові дані Feishu enterprise-додатку, Telegram Bot Token, облікові дані QQ Bot, облікові дані DingTalk, токен WeChat iLink, Discord Bot Token, WhatsApp (QR-сканування при першому запуску) — лише якщо потрібна IM-інтеграція.

> Claude Code CLI не потрібно встановлювати вручну — залежність проєкту від Claude Agent SDK містить повний CLI runtime, автоматично встановлюється при першому `make start`.

### Встановлення і запуск

```bash
# 1. Клонувати репозиторій
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Запуск однією командою (перший раз встановлює залежності + компілює)
make start
```

Відкрийте http://localhost:9898 і дотримуйтесь майстра налаштування: створіть адміністратора (без дефолтного акаунта), налаштуйте Claude API та, за потреби, IM-канали. Усе налаштовується з веб-інтерфейсу, без конфігураційних файлів. API-ключі шифруються AES-256-GCM.

### Активація режиму container

Користувач admin за замовчуванням використовує host-режим (без Docker). Режим container потрібен для користувачів member (активується автоматично після реєстрації):

```bash
./container/build.sh
```

Після реєстрації нового користувача головний workspace у режимі container (`home-{userId}`) створюється автоматично, без додаткової конфігурації.

## Огляд архітектури


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink складається з чотирьох незалежних Node.js-проєктів:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): головний сервіс із маршрутизатором повідомлень (2s polling + дедуплікація), конкурентною чергою (до 20 контейнерів + 5 host-процесів), планувальником задач (cron / interval / once), WebSocket-сервером для реального часу і термінала, автентифікацією bcrypt + HMAC Cookie, RBAC та AES-256-GCM-шифрованим конфігом. SQLite-збереження (WAL-режим, схема v1→v51). Також містить шари Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox та Claude Code Plugins.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, з react-markdown, mermaid, recharts, xterm.js та мобільною PWA.
- **Agent Runner** (`container/agent-runner/`): виконавчий рушій, що працює у Docker-контейнері або як host-процес; викликає `query()` з Claude Agent SDK, емітує 30+ типів StreamEvent через stdout і надає 27 MCP-інструментів головному процесу через файловий IPC з атомарними записами.
- **Desktop** (`desktop/`): Electron-оболонка, що пакує автономний додаток для macOS / Windows / Linux.

Вісім IM-каналів (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) входять через маршрутизатор, дедуплікуються і спрямовуються до черги, яка через provider pool обирає API-ключ / двигун і запускає контейнер, host-процес або пісочницю. Streaming-події транслюються через WebSocket до веб-клієнтів або повертаються через IM API до кожного каналу.

## Повна документація

Повний посібник доступний тут:

- [Повна англійська версія](README.md)
- [Повна 简体中文 версія](README.zh-CN.md)

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

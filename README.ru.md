<details>
<summary><b>🌐 Languages</b></summary>

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

</details>

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Самохостинговая многопользовательская локальная система Loop Engineering AI Agent (десктоп + браузер + мобильные) / На базе AI Genius Institute
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


## Что такое DeepThink?

DeepThink — корпоративная платформа самоэволюции автономного Agent-суперинтеллекта, пионер перехода от парадигмы Harness Engineering к Loop Engineering, новое поколение AI-инфраструктуры (AI Infra) для корпоративных клиентов. Платформа DeepThink построена вокруг фреймворка многого Agent-взаимодействия, объединяя AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop и Human-Agent Symbiosis для создания корпоративной AI-системы, которая непрерывно учится, самосовершенствуется и в конечном итоге вырастает в суперинтеллект:

- **Платформа автономной AI-разработки** — Agent независимо проходит полный жизненный цикл разработки ПО, исключая участие инженеров-людей в рутинных задачах кодирования
- **Движок самоэволюционирующего Agent** — Agent непрерывно учится на ошибках, поглощает знания из кодовой базы и эволюционирует на основе отзывов пользователей
- **Центр сотрудничества программиста и Agent** — У каждого программиста есть личный "Проект разработки" с несколькими параллельными сессиями, а центральный планировщик предотвращает конфликты параллелизма
- **Корпоративная SaaS-платформа** — Мультитенантная изоляция, иерархические права, эластичный биллинг и корпоративные интеграции (Feishu/DingTalk/WeCom/LDAP)
- **Инкубатор суперинтеллекта** — Посредством непрерывной эволюции единичный Agent в конечном итоге обретает комплексные возможности полноценной программной команды

> "Пусть у каждого предприятия будет никогда не останавливающаяся, непрерывно эволюционирующая AI-суперкоманда R&D — от пользователя инструментов, до создателя кода, в конечном итоге вырастающая в самовоспроизводящийся суперинтеллект. Пройдем этот путь к AGI вместе."

### Ключевые особенности

- **На базе Claude Code** — построен на Claude Agent SDK, подлежащий рантайм — полный Claude Code CLI, наследует все его способности
- **Harness и Loop Engineering** — версионированные harness-манифесты (системный промпт / subagents / инструменты / skills) со snapshot / diff / eval / promote / rollback, плюс долгоживущие автономные циклы задач с проверкой каждой итерации и реинжекцией неудач
- **Autonomy Layer и Autonomous Mode** *(v1.1.0)* — Сквозная Autonomy Layer объединяет 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) с metrics collection и E2E acceptance; плюс полный Autonomous Mode, позволяющий Агенту завершать задачу end-to-end без человеческого контроля, покрывая three defense layers (CLAUDE.md конституционное переопределение / Supervisor обход уточнения / RLHF вежливость конца хода) и four hard brakes (деструктивные команды / лимит ходов / лимит токенов / обнаружение цикла)
- **Agent-as-a-Service (PaaS)** — создание, версия, монтирование, совместное использование и установка хранящихся в БД определений Agent между тенантами, с квотами на пользователя, модерацией администратора и публикуемым маркетплейсом шаблонов
- **Многопользовательская изоляция** — рабочее пространство на пользователя, IM-каналы на пользователя, система разрешений RBAC, регистрация по пригласительному коду, журнал аудита
- **Единая маршрутизация восьми каналов** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp и веб-интерфейс — все маршрутизируются единообразно
- **Много-движков и много-провайдеров** — подключаемые движки code-agent (Claude Code / AtomCode / Codex / OpenCode) и несколько провайдеров Claude API с тремя стратегиями балансировки (round-robin / weighted / failover), автоматическая проверка здоровья
- **Изолированное выполнение кода** — усиленный sandbox на базе Docker + seccomp + cgroups для выполнения Python / Node / shell-кода и браузерной автоматизации Chromium CDP
- **Биллинг и статистика использования** — полная система биллинга (планы подписки, кошелёк, коды пополнения), отслеживание токенов по моделям с графиками
- **Мобильный PWA** — глубоко оптимизирован для мобильных, установка одним кликом на рабочий стол, iOS / Android адаптированы
- **Интернационализация** — 29 языков интерфейса с нативными эндонимами и поддержкой RTL; Agent отвечает на выбранном пользователем языке

## Демонстрация возможностей

Визуальный обзор ключевых возможностей DeepThink — как выглядит каждый экран и какую ценность он даёт пользователю.

| Скриншот | Функция | Ключевые особенности | Что это значит для вас |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Основное рабочее пространство** | Вкладки с несколькими диалогами, потоковый Markdown, панель размышлений в реальном времени, трассировка вызовов инструментов | В одном рабочем пространстве — множество параллельных чатов: переключайте контекст без потери состояния и наблюдайте, как Agent думает и действует вживую |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Создание / версионирование / подключение пользовательских определений Agent, предпроверка возможностей хоста, управление снапшотами | Определяйте собственных профильных Agent (code-reviewer, web-researcher, …) и переиспользуйте их в каждой сессии |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Редактор Agent** | Редактирование `~/.claude/agents/*.md` из Web UI, системный промпт + инструменты + сабагенты в одной форме | Настраивайте поведение Agent на естественном языке — без копания в файлах, изменения применяются со следующей сессии |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Тестирование Agent** | Запуск Agent на тестовых входах перед публикацией, просмотр полного вывода | Выпускайте Agent уверенно — проверяйте поведение на тест-кейсах до запуска в продакшн |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Мульти-движок** | Подключаемые движки (Claude Code / AtomCode / Codex / OpenCode), единая панель доступности | Выбирайте лучший «мозг» для каждой задачи — переключайте движки по сессии без переделки платформы |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Конфигурация движка** | Жизненный цикл демона по движку, учётные данные провайдера, состояние здоровья с одного взгляда | Запускайте несколько провайдеров параллельно — добавляйте учётные данные, следите за доступностью и автоматический отказоустойчивый переход |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Движок AtomCode** | Автономный HTTP/SSE-демон, loopback-порт на каждый agent-runner, авто-демонтаж | Используйте AtomCode как альтернативный движок кодинга — изолированный демон на процесс, без конфликтов портов |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Шаблоны, публикуемые администратором (agent / mcp / skill / kb), просмотр, оценки, установка в один клик | Находите и устанавливайте общие Agent и инструменты как в магазине приложений — админ курирует, пользователи ставят одним кликом |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | stdio + HTTP MCP Servers на рабочее пространство, независимо от глобального конфига | Давайте каждому рабочему пространству свой набор инструментов — подключайте Notion, GitHub, базы данных… скоуп ровно под проект |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills уровня проекта / пользователя / рабочего пространства, авто-обнаружение через тома и симлинки | Обучайте Agent новым трюкам по проекту — без пересборки образа, навыки появятся в следующей сессии |
| <img src="static/deep-think-memory.png" width="280" /> | **Система памяти** | Память пользовательская-глобальная / сессии / по дате, полнотекстовый поиск, редактирование онлайн | Agent помнит вас между сессиями — вспоминайте предпочтения, контекст проекта и решения без повторных объяснений |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Расписание задач** | Cron / интервал / разовое, выполнение Agent или скрипта, контекст группы или изолированный, уведомление в IM по завершении | Автоматизируйте повторяющуюся работу — ночные отчёты, периодические проверки, самозапускающиеся циклы, которые пингуют вас в Feishu/Telegram |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Изолированное выполнение** | Docker + seccomp + cgroups, код на Python / Node / shell, браузерная автоматизация Chromium CDP | Пусть Agent запускает недоверенный код и управляет браузером безопасно — усиленная изоляция, доступно как MCP-инструменты |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Системный монитор** | Список контейнеров, состояние очереди, активные сессии по провайдерам, проверки здоровья, сборка образа в один клик | Видите, что именно запущено — замечайте зависшие контейнеры, балансируйте нагрузку и пересобирайте образы из браузера |
| <img src="static/deep-think-tokens.png" width="280" /> | **Использование и биллинг** | Детализация токенов по моделям (вход / выход / кэш), стоимость в USD, столбчатые и круговые диаграммы, многомерные фильтры | Знайте, куда уходят токены и деньги — срезы по пользователю, модели и временному диапазону, точно билльте команды |
| <img src="static/deep-think-about.png" width="280" /> | **О проекте** | Версия, инфо о сборке, ссылки проекта, проверка обновлений в один клик | Будьте в курсе — смотрите версию сборки и сразу переходите к документации, репозиторию и каналам обновлений |

## Быстрый старт

### Предварительные требования

**Обязательно**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (для режима контейнера; администратору только в режиме хоста не нужен), и ключ Claude API (официальный Anthropic или совместимый ретрансляционный сервис).

**Опционально**: учётные данные корпоративного приложения Feishu, Telegram Bot Token, учётные данные QQ Bot, учётные данные DingTalk, токен WeChat iLink, Discord Bot Token, WhatsApp (QR-сканирование при первом запуске) — только если нужны IM-интеграции.

> Claude Code CLI устанавливать вручную не нужно — зависимость проекта Claude Agent SDK уже включает полный рантайм CLI, автоматически устанавливается при первом запуске `make start`.

### Установка и запуск

```bash
# 1. Клонировать репозиторий
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Запуск одной командой (первый раз устанавливает зависимости и компилирует)
make start
```

Откройте http://localhost:9898 и следуйте мастеру настройки: создайте администратора (учётной записи по умолчанию нет), настройте Claude API и при желании — IM-каналы. Вся конфигурация выполняется через веб-интерфейс, без конфигурационных файлов. Ключи API хранятся зашифрованными через AES-256-GCM.

### Включить режим контейнера

Администратор по умолчанию использует режим хоста (Docker не нужен). Если нужен режим контейнера (пользователи member используют его автоматически после регистрации):

```bash
./container/build.sh
```

После регистрации каждый новый пользователь автоматически получает главное рабочее пространство в режиме контейнера (`home-{userId}`), без дополнительной настройки.

## Обзор архитектуры


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink состоит из четырёх независимых проектов Node.js:

- **Бэкенд** (Node.js 22 + TypeScript 5.9 + Hono): основной сервис с маршрутизатором сообщений (опрос 2с + дедупликация), очередью конкурентности (до 20 контейнеров + 5 хост-процессов), планировщиком задач (cron / interval / once), WebSocket-сервером для потоковой передачи и терминала, аутентификацией bcrypt + HMAC Cookie, RBAC и управлением конфигурацией с шифрованием AES-256-GCM. Данные в SQLite (режим WAL, схема v1→v51). Также включает слои Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox и Claude Code Plugins.
- **Фронтенд** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, с react-markdown, mermaid, recharts, xterm.js и мобильным PWA.
- **Agent Runner** (`container/agent-runner/`): движок выполнения, работающий внутри Docker-контейнера или как хост-процесс; вызывает `query()` из Claude Agent SDK, эмиттит 30+ типов StreamEvent через stdout и предоставляет 27 инструментов MCP главному процессу через файловые IPC-каналы с атомарной записью.
- **Десктоп** (`desktop/`): оболочка Electron, упаковывающая автономное приложение для macOS / Windows / Linux.

Восемь IM-каналов (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) поступают в маршрутизатор, дедуплицируются и направляются в очередь, которая через пул провайдеров выбирает ключ API / движок и запускает контейнер, хост-процесс или sandbox. Потоковые события транслируются через WebSocket веб-клиентам или отправляются через IM-API обратно в каждый канал.

## Полная документация

Полное руководство смотрите здесь:

- [Полная английская версия](README.md)
- [Полная версия на 简体中文](README.zh-CN.md)

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

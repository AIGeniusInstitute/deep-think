**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  سیستم خودمیزبانی چندکاربرهٔ محلی AI Agent Loop Engineering (دسکتاپ + مرورگر + موبایل) / Powered By AI Genius Institute
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


## DeepThink چیست

DeepThink، یک پلتفرم خود-تکامل‌یافته ابر-هوش Agent خودمختار در سطح سازمانی، پیشگام گذار از پارادایم Harness Engineering به Loop Engineering، نسل جدیدی از زیرساخت هوش مصنوعی (AI Infra) برای مشتریان سازمانی است. پلتفرم DeepThink بر چارچوب همکاری چند-Agent متمرکز است و AI Coding، Self-Evolving، Full-Stack Observability، Bug Auto-Fix Loop و Human-Agent Symbiosis را ترکیب می‌کند تا یک سیستم هوش مصنوعی سازمانی بسازد که به طور مداوم یاد می‌گیرد، خود را بهبود می‌بخشد و در نهایت به ابر-هوش تبدیل می‌شود:

- **پلتفرم R&D خودمختار با هوش مصنوعی** — Agent به طور مستقل چرخه کامل توسعه نرم‌افزار را تکمیل می‌کند، بدون نیاز به مهندسان انسانی در وظایف برنامه‌نویسی روزمره
- **موتور Agent خود-تکاملی** — Agent به طور مداوم از خطاها یاد می‌گیرد، دانش را از پایگاه کد جذب می‌کند و از بازخورد کاربران تکامل می‌یابد
- **مرکز همکاری برنامه‌نویس-Agent** — هر برنامه‌نویس دارای یک «پروژه توسعه» شخصی است که شامل چندین جلسه موازی است و یک زمان‌بند مرکزی از تعارضات همزمانی جلوگیری می‌کند
- **پلتفرم SaaS سازمانی** — جداسازی چندمستاجری، مجوزهای سلسله‌مراتبی، صورت‌حساب انعطاف‌پذیر و یکپارچگی‌های سازمانی (Feishu/DingTalk/WeCom/LDAP)
- **انکوباتور ابر-هوش** — از طریق تکامل مداوم، در نهایت یک Agent واحد به قابلیت‌های جامع یک تیم نرم‌افزاری کامل دست می‌یابد

> «بگذارید هر سازمان صاحب یک تیم ابر-R&D هوش مصنوعی باشد که هرگز متوقف نمی‌شود و به طور مداوم تکامل می‌یابد — از کاربر ابزار، به خالق کد، و در نهایت رشد یافته به ابر-هوشی که خود را تکثیر می‌کند. بیایید با هم در مسیر رسیدن به AGI گام برداریم.»"

### ویژگی‌های کلیدی

- **موتور بومی Claude Code** — بر پایهٔ Claude Agent SDK، با runtime کامل Claude Code CLI در زیر، و ارث‌بری همهٔ توانایی‌های آن
- **Harness و Loop Engineering** — manifestهای نسخه‌بندی‌شدهٔ harness (system prompt / subagents / tools / skills) با snapshot / diff / eval / promote / rollback، به‌علاوهٔ حلقه‌های وظیفهٔ خودمختار طولانی‌مدت با بازبینی هر تکرار و تزریق مجدد شکست
- **Autonomy Layer و Autonomous Mode** *(v1.1.0)* — یک Autonomy Layer میان‌برشی ۷ قابلیت (perception / cognition / decision / execution / learning / adaptation / monitoring) را با metrics collection و E2E acceptance یکپارچه می‌کند؛ به‌علاوه یک Autonomous Mode کامل که به Agent اجازه می‌دهد یک وظیفه را end-to-end بدون دست‌هدایت انسانی کامل کند، سه defense layers را پوشش می‌دهد (CLAUDE.md لغو قانون اساسی / Supervisor دور زدن شفاف‌سازی / RLHF مؤدبت پایان نوبت) و four hard brakes (دستورات مخرب / محدودیت نوبت / محدودیت token / تشخیص حلقه)
- **Agent-as-a-Service (PaaS)** — تعریف Agentهای مبتنی بر DB با ایجاد، نسخه‌بندی، mount، اشتراک و نصب بین مستاجر، همراه با سهمیهٔ per-user، بازبینی ادمین و یک بازارچهٔ قالب قابل انتشار
- **جداسازی چندکاربره** — workspace هر کاربر، کانال IM هر کاربر، سیستم دسترسی RBAC، ثبت‌نام با کد دعوت، لاگ ممیزی
- **مسیریابی یکپارچهٔ هشت‌کاناله** — Feishu، Telegram، QQ، DingTalk، WeChat، Discord، WhatsApp و رابط وب — همه به‌طور یکنواخت مسیریابی می‌شوند
- **چندموتوره و چندprovider** — موتورهای کد-Agent قابل تعویض (Claude Code / AtomCode / Codex / OpenCode) و چند providerهای Claude API با سه راهبرد موازنهٔ بار (round-robin / weighted / failover) و بررسی سلامت خودکار
- **اجرای کد در sandbox** — sandbox سخت‌شدهٔ Docker + seccomp + cgroups برای اجرای کد Python / Node / shell و اتوماسیون مرورگر Chromium CDP
- **صورتحساب و آمار استفاده** — سیستم صورتحساب کامل (اشتراک، کیف پول، کدهای بازخرید)، ردیابی توکن به تفکیک مدل با نمودار
- **PWA موبایل** — بهینه برای موبایل، نصب روی صفحهٔ اصلی با یک کلیک، سازگار با iOS و Android
- **بین‌المللی** — 29 زبان رابط کاربری با endonym بومی و پشتیبانی RTL؛ Agent به زبان انتخابی کاربر پاسخ می‌گوید

## نمایش ویژگی‌ها

گشت تصویری در قابلیت‌های هسته DeepThink — هر صفحه چه چیزی نشان می‌دهد و چه ارزشی برای کاربر دارد.

| اسکرین‌شات | ویژگی | نکات کلیدی | برای شما چه معنایی دارد |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **فضای کار اصلی** | تب‌های چندگانه مکالمه، پخش Markdown، پنل تفکر بلادرنگ، ردیابی فراخوان ابزار | یک فضای کار می‌گوید چندین گفت‌وگوی موازی را در خود جای دهد — بدون از دست دادن حالت، زمینه را عوض کنید و تماشا کنید که Agent زنده فکر و عمل کند |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **استودیوی Agent** | ساخت / نسخه‌گذاری / سوار کردن تعاریف سفارشی Agent، پیش‌پویش توانایی میزبان، مدیریت اسنپ‌شات | Agent‌های تخصصی خودتان (بازبین کد، پژوهشگر وب…) را تعریف کنید و در همه جلسه‌ها بازاستفاده کنید |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **ویرایشگر Agent** | ویرایش `~/.claude/agents/*.md` از رابط وب، پرامپت سیستمی + ابزارها + subagent‌ها در یک فرم | رفتار Agent را به زبان ساده کوک کنید — بدون کند و کاو در فایل‌ها، تغییر‌ها در جلسه بعد اعمال می‌شوند |
| <img src="static/deep-think-agent-test.png" width="280" /> | **آزمون Agent** | اجرای Agent روی ورودی‌های نمونه پیش از انتشار، بررسی رد کامل خروجی | Agent‌ها با اطمینان منتشر کنید — رفتار را روی موارد آزمون اعتبارسنجی کنید پیش از رها کردن در تولید |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **چند موتوره** | موتورهای قابل سوار شدن (Claude Code / AtomCode / Codex / OpenCode)، داشبورد در دسترس یکپارچه | بهترین مغز را برای هر کارتان برگزینید — بدون بازمعماری پلتفرم، موتورها را به ازای جلسه عوض کنید |
| <img src="static/deep-think-engine-config.png" width="280" /> | **پیکربندی موتور** | چرخه‌حیات daemon به ازای موتور، اعتبارنامه ارائه‌دهنده، وضعیت سلامی در یک نگاه | چند ارائه‌دهنده را کنار هم اجرا کنید — اعتبارنامه بیفزایید، زنده بودن را پایش کنید و در صورت شکست خودکار جایگزین کنید |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **موتور AtomCode** | daemon مستقل HTTP/SSE، پورت loopback به ازای agent-runner، teardown خودکار | AtomCode را به عنوان موتور کدنویسی جایگزین به‌کار ببرید — daemon ایزوله به ازای فرآیند، بدون تداخل پورت |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | قالب‌های قابل انتشار توسط مدیر (agent / mcp / skill / kb)، مرور، رتبه‌دهی، نصب یک‌کلیکی | Agent‌ها و ابزارهای مشترک را مانند فروشگاه اپ کشف و نصب کنید — مدیران منتقی می‌کنند، کاربران یک‌کلیکی نصب می‌کنند |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **سرورهای MCP** | سرورهای MCP stdio + HTTP به ازای فضای کار، مستقل از پیکربندی سراسری | به هر فضای کار جعبه‌ابزار مختص خودش بدهید — Notion، GitHub، پایگاه‌داده‌ها را دقیقاً محدود به همان پروژه وصل کنید |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills در سطح پروژه / کاربر / فضای کار، کشف خودکار از طریق volume mounts + symlink‌ها | به ازای پروژه به Agent ترفندهای تازه بیاموزید — بدون بازسازی ایمیج، Skills در جلسه بعد پدیدار می‌شوند |
| <img src="static/deep-think-memory.png" width="280" /> | **سیستم حافظه** | حافظه سراسری کاربر / جلسه / تاریخ، جستجوی متن کامل، ویرایش آنلاین | Agent در طول جلسه‌ها شما را به یاد می‌سپارد — ترجیحات، زمینه پروژه و تصمیم‌ها را بدون توضیح دوباره فراخوانی کنید |
| <img src="static/deep-think-cron-task.png" width="280" /> | **وظایف زمان‌بندی‌شده** | cron / بازه / یک‌باره، اجرای Agent یا اسکریپت، زمینه گروه یا ایزوله، اعلان IM هنگام تکمیل | کار تکراری را خودکار کنید — گزارش‌های شبانه، بررسی‌های دوره‌ای، حلقه‌های خود‌اجرایی که پس از پایان در Feishu/Telegram به شما اعلان می‌دهند |
| <img src="static/deep-think-sandbox.png" width="280" /> | **اجرای سندباکس‌شده** | Docker + seccomp + cgroups، کد Python / Node / shell، اتوماسیون مرورگر Chromium با CDP | بگذارید Agent کد نامعتبر را اجرا کند و مرورگری را ایمن رانندگی کند — ایزولاسیون سخت‌گیرانه، به‌صورت ابزارهای MCP در دسترس |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **پایشگر سیستم** | فهرست کانتینرها، وضعیت صف، جلسه‌های فعال به ازای ارائه‌دهنده، بررسی سلامت، ساخت ایمیج یک‌کلیکی | دقیقاً ببینید چه‌چیزی در حال اجراست — کانتینرهای گیرکرده را ردیابی، بار را متوازن کنید و ایمیج‌ها را از مرورگر بازسازی کنید |
| <img src="static/deep-think-tokens.png" width="280" /> | **استفاده و فوترة** | تفکیک توکن به ازای مدل (ورودی / خروجی / کش)، هزینه دلاری، نمودارهای میله‌ای و دایره‌ای، فیلترهای چندبعدی | بدانید توکن‌ها و پولتان کجا می‌رود — برچسبش بر پایه کاربر، مدل و بازه زمانی، و صورتحساب دقیق تیم‌ها |
| <img src="static/deep-think-about.png" width="280" /> |**درباره** | نسخه، اطلاعات ساخت، پیوندهای پروژه، بررسی به‌روزرسانی یک‌کلیکی | به‌روز بمانید — نسخه ساخت خود را ببینید و مستقیم به مستندات، مخزن و کانال‌های به‌روزرسانی بروید |

## شروع سریع

### پیش‌نیازها

**الزومی**: [Node.js](https://nodejs.org) >= 20، [Docker](https://www.docker.com/) (برای حالت container؛ برای حالت host ادمین لازم نیست)، کلید Claude API (Anthropic رسمی یا سرویس relay سازگار).

**اختیاری**: اعتبارنامه‌های Feishu Enterprise App، Telegram Bot Token، اعتبارنامه‌های QQ Bot، اعتبارنامه‌های DingTalk، توکن WeChat iLink، Discord Bot Token، WhatsApp (اسکن QR در اولین اجرا) — تنها در صورت نیاز به اتصال IM.

> نیازی به نصب دستی Claude Code CLI نیست — وابستگی پروژه به Claude Agent SDK شامل runtime کامل CLI است و در اولین `make start` به‌طور خودکار نصب می‌شود.

### نصب و راه‌اندازی

```bash
# 1. کلون مخزن
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. راه‌اندازی با یک دستور (در اولین اجرا نصب وابستگی‌ها + کامپایل)
make start
```

به http://localhost:9898 بروید و جادوگر نصب را دنبال کنید: ایجاد ادمین (بدون حساب پیش‌فرض)، پیکربندی Claude API و در صورت نیاز کانال‌های IM. همه‌چیز از رابط وب پیکربندی می‌شود و نیازی به فایل پیکربندی نیست. کلیدهای API با AES-256-GCM رمزنگاری و ذخیره می‌شوند.

### فعال‌سازی حالت container

کاربر ادمین به‌طور پیش‌فرض از حالت host (بدون Docker) استفاده می‌کند. حالت container برای کاربران member پس از ثبت‌نام به‌طور خودکار فعال می‌شود:

```bash
./container/build.sh
```

پس از ثبت‌نام کاربر جدید، workspace اصلی در حالت container (`home-{userId}`) خودکار ساخته می‌شود و نیازی به پیکربندی اضافی نیست.

## مرور معماری


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink از چهار پروژهٔ مستقل Node.js تشکیل شده است:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): سرویس اصلی با مسیریاب پیام (polling 2s + حذف تکرار)، صف همزمان (تا 20 container + 5 فرآیند host)، زمان‌بند وظایف (cron / interval / once)، سرور WebSocket برای streaming بلادرنگ و ترمینال، احراز هویت bcrypt + HMAC Cookie، RBAC، و مدیریت پیکربندی رمزنگاری‌شده AES-256-GCM. ماندگاری SQLite (حالت WAL، schema v1→v51). همچنین لایه‌های Harness / Loop Engineering، Agent-as-a-Service (PaaS)، Sandbox و Claude Code Plugins را در بر می‌گیرد.
- **Frontend** (`web/`): یک SPA با React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4، همراه با react-markdown، mermaid، recharts، xterm.js و PWA موبایل.
- **Agent Runner** (`container/agent-runner/`): موتور اجرایی که در Docker container یا به‌عنوان فرآیند host اجرا می‌شود؛ تابع `query()` از Claude Agent SDK را فراخوانی می‌کند، بیش از 30 نوع StreamEvent را از طریق stdout emit می‌کند و 27 ابزار MCP را از طریق کانال‌های IPC فایلی با نوشتن اتمیک به فرآیند اصلی ارائه می‌دهد.
- **Desktop** (`desktop/`): یک پوستهٔ Electron که یک اپ مستقل برای macOS / Windows / Linux بسته‌بندی می‌کند.

هشت کانال IM (Feishu، Telegram، QQ، DingTalk، WeChat، Discord، WhatsApp، Web) از طریق مسیریاب وارد می‌شوند، پس از حذف تکرار در صف قرار می‌گیرند، کلید API / موتور را از طریق ProviderPool انتخاب می‌کنند و container، فرآیند host یا sandbox راه‌اندازی می‌گردد. رویدادهای streaming با WebSocket به کلاینت‌های وب و از طریق IM API به هر کانال بازمی‌گردند.

## مستندات کامل

راهنمای کامل را اینجا ببینید:

- [نسخهٔ کامل انگلیسی](README.md)
- [نسخهٔ کامل 简体中文](README.zh-CN.md)

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

<details>
<summary><b>🌐 Languages</b></summary>

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

</details>

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center" dir="rtl">
  نظام هندسة حلقات وكيل الذكاء الاصطناعي محلي ذاتي الاستضافة متعدد المستخدمين (سطح المكتب + المتصفح + الجوال) / مدعوم من معهد AI Genius
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


<div dir="rtl">

## ما هو DeepThink؟

DeepThink، منصة تطوّر ذاتي لذكاء فائق Agent المؤسسية، رائدة في التحول من نموذج Harness Engineering إلى Loop Engineering، هي الجيل الجديد من بنية الذكاء الاصطناعي (AI Infra) للعملاء المؤسسيين. تتمحور منصة DeepThink حول إطار تعاون متعدد العوامل (Agent)، وتدمج AI Coding و Self-Evolving و Full-Stack Observability و Bug Auto-Fix Loop و Human-Agent Symbiosis لبناء نظام ذكاء اصطناعي مؤسسي يتعلم باستمرار ويحسّن نفسه وينمو في النهاية ليصبح ذكاءً فائقاً:

- **منصة البحث والتطوير الذاتية بالذكاء الاصطناعي** — يكمل العامل (Agent) بشكل مستقل دورة حياة تطوير البرمجيات الكاملة، دون الحاجة إلى مهندسين بشريين في مهام الترميز الروتينية
- **محرك العامل ذي التطور الذاتي** — يتعلم العامل باستمرار من الأخطاء، ويمتص المعرفة من قاعدة الشيفرة، ويتطور من ملاحظات المستخدمين
- **مركز تعاون المبرمج والعامل** — يمتلك كل مبرمج "مشروع تطوير" شخصياً يحتوي على جلسات متوازية متعددة، ويمنع جدول مركزي تعارضات التزامن
- **منصة SaaS مؤسسية** — عزل متعدد المستأجرين، أذونات هرمية، فوترة مرنة، وتكاملات مؤسسية (Feishu/DingTalk/WeCom/LDAP)
- **حاضنة الذكاء الفائق** — من خلال التطور المستمر، يصل عامل واحد في النهاية إلى القدرات الشاملة لفريق برمجيات كامل

> "لتمتلك كل مؤسسة فريق بحث وتطوير فائق للذكاء الاصطناعي لا يتوقف أبداً ويتطور باستمرار — من مستخدم للأدوات، إلى مُنشئ للشيفرة، لينمو أخيراً ليصبح ذكاءً فائقاً ذاتي التكاثر. لنمشِ معاً على الطريق نحو AGI."

### الميزات الرئيسية

- **مدفوع بـ Claude Code أصلاً** — مبني على Claude Agent SDK، تحته runtime كامل لـ Claude Code CLI، يرث جميع قدراته
- **هندسة Harness و Loop** — بيانات هارنس مُصدَّقة (system prompt / subagents / tools / skills) مع snapshot / diff / eval / promote / rollback، بالإضافة إلى حلقات مهام ذاتية طويلة الأمد مع مراجعة لكل تكرار وإعادة حقن الفشل
- **Autonomy Layer و Autonomous Mode** *(v1.1.0)* — Autonomy Layer متعددة الجوانب توحّد القدرات السبع (perception / cognition / decision / execution / learning / adaptation / monitoring) مع metrics collection و E2E acceptance؛ بالإضافة إلى Autonomous Mode كامل يتيح للوكيل إكمال المهمة من البداية إلى النهاية دون تدخل بشري مباشر، يغطي three defense layers (CLAUDE.md تجاوز دستوري / Supervisor تجاوز التوضيح / RLHF لباقة نهاية الدور) و four hard brakes (أوامر مدمرة / حد الأدوار / حد الـ token / كشف التكرار)
- **الوكيل كخدمة (PaaS)** — إنشاء وإصدار وتركيب ومشاركة وتثبيت تعريفات الوكيل المدعومة بقاعدة بيانات عبر المستأجرين، مع حصص لكل مستخدم ومراجعة المسؤول وسوق قوالب قابل للنشر
- **عزل متعدد المستخدمين** — مساحة عمل لكل مستخدم، قنوات مراسلة فورية لكل مستخدم، نظام صلاحيات RBAC، تسجيل بكود دعوة، سجلات تدقيق
- **توجيه موحد لثماني قنوات** — Feishu، Telegram، QQ، DingTalk، WeChat، Discord، WhatsApp، وواجهة Web — جميعها موجهة بشكل موحد
- **متعدد المحركات ومتعدد المزودين** — محركات وكيل شيفرة قابلة للتركيب (Claude Code / AtomCode / Codex / OpenCode) ومزودو Claude API متعددون بثلاث استراتيجيات موازنة (round-robin / weighted / failover) مع فحص صحة تلقائي
- **تنفيذ شيفرة في صندوق رمل** — صندوق رمل مُعزَّز بـ Docker + seccomp + cgroups لتنفيذ شيفرة Python / Node / shell وأتمتة متصفح Chromium عبر CDP
- **الفوترة وإحصاءات الاستخدام** — نظام فوترة كامل (اشتراك، محفظة، أكواد استبدال)، تتبع الرموز لكل نموذج مع رسوم بيانية
- **PWA للجوال** — مُحسّن بعمق للجوال، تثبيت بنقرة واحدة على الشاشة الرئيسية، iOS و Android مُكيّفان
- **مُدول لغوياً** — 29 لغة واجهة بأسماء ذاتية أصلية ودعم RTL؛ يرد الوكيل باللغة التي اختارها المستخدم

## عرض الميزات

جولة بصرية في قدرات DeepThink الأساسية — كيف يبدو كل شاشة والقيمة التي تقدمها للمستخدم.

| لقطة الشاشة | الميزة | أبرز النقاط | ماذا يعني ذلك بالنسبة لك |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **مساحة العمل الرئيسية** | تبويبات متعددة للمحادثات، بث Markdown، لوحة تفكير في الوقت الفعلي، تتبع استدعاء الأدوات | مساحة عمل واحدة تجمع محادثات متوازية كثيرة — بدّل السياق دون فقدان الحالة، وراقب Agent يفكّر ويتصرّف مباشرة |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **استوديو Agent** | إنشاء / إصدار / تركيب تعريفات Agent مخصصة، فحص مسبق لقدرات المضيف، إدارة اللقطات | عرّف Agents الخاصين بك (مراجع الكود، باحث الويب…) وأعد استخدامهم عبر كل جلسة |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **محرر Agent** | حرّر `~/.claude/agents/*.md` من واجهة الويب، موجه النظام + الأدوات + Agents الفرعيين في نموذج واحد | اضبط سلوك Agent بلغة عادية — دون تنقيب في الملفات، والتغييرات تُطبَّق في الجلسة التالية |
| <img src="static/deep-think-agent-test.png" width="280" /> | **اختبار Agent** | شغّل Agent ضد مدخلات نموذجية قبل النشر، افحص تتبع الإخراج الكامل | انشر Agents بثقة — تحقّق من السلوك على حالات اختبارية قبل إطلاقهم في الإنتاج |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **محركات متعددة** | محركات قابلة للتوصيل (Claude Code / AtomCode / Codex / OpenCode)، لوحة توفر موحّدة | اختر العقل الأنسب لكل مهمة — بدّل المحركات لكل جلسة دون إعادة هيكلة المنصة |
| <img src="static/deep-think-engine-config.png" width="280" /> | **تكوين المحرك** | دورة حياة daemon لكل محرك، بيانات اعتماد المزوّد، حالة الصحة بنظرة واحدة | شغّل عدة مزوّدين جنبًا إلى جنب — أضف بيانات الاعتماد، راقب الحيوية، والتبديل التلقائي عند الفشل |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **محرك AtomCode** | daemon HTTP/SSE مستقل، منفذ loopback لكل agent-runner، تفكيك تلقائي | استخدم AtomCode كمحرك برمجة بديل — daemon معزول لكل عملية، بلا تعارض في المنافذ |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | قوالب قابلة للنشر من المسؤول (agent / mcp / skill / kb)، تصفّح، تقييم، تثبيت بنقرة واحدة | اكتشف وثبّت Agents وأدوات مشتركة كمتجر تطبيقات — المسؤول ينتقي، والمستخدمون يثبّتون بنقرة واحدة |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **خوادم MCP** | خوادم MCP stdio + HTTP لكل مساحة عمل، مستقلة عن التكوين العام | امنح كل مساحة عمل مجموعتها الخاصة من الأدوات — اربط Notion، GitHub، قواعد البيانات… محدودة النطاق تمامًا بذلك المشروع |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills بمستوى المشروع / المستخدم / مساحة العمل، تُكتشف تلقائيًا عبر وحدات التخزين + الروابط الرمزية | علّم Agent حِيلًا جديدة لكل مشروع — دون إعادة بناء الصورة، وتظهر Skills في الجلسة التالية |
| <img src="static/deep-think-memory.png" width="280" /> | **نظام الذاكرة** | ذاكرة عامة للمستخدم / جلسة / تاريخ، بحث نصّي كامل، تحرير عبر الإنترنت | يتذكّرك Agent عبر الجلسات — استرجع التفضيلات وسياق المشروع والقرارات دون إعادة الشرح |
| <img src="static/deep-think-cron-task.png" width="280" /> | **المهام المجدولة** | cron / فاصل زمني / لمرة واحدة، تنفيذ Agent أو نص برمجي، سياق مجموعة أو معزول، إشعار IM عند الاكتمال | أتمت العمل المتكرر — تقارير ليلية، فحوصات دورية، حلقات تعمل ذاتيًا تنبّهك على Feishu/Telegram عند الانتهاء |
| <img src="static/deep-think-sandbox.png" width="280" /> | **التنفيذ المعزول** | Docker + seccomp + cgroups، كود Python / Node / shell، أتمتة متصفح Chromium عبر CDP | دع Agent يشغّل كودًا غير موثوق به ويقود متصفحًا بأمان — عزل مُحصَّن، مكشوف كأدوات MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **مراقب النظام** | قائمة الحاويات، حالة الطابور، الجلسات النشطة لكل مزوّد، فحوصات الصحة، بناء صورة بنقرة واحدة | اعرف بالضبط ما يجري — رصد الحاويات العالقة، وازن الحمل، وأعد بناء الصور من المتصفح |
| <img src="static/deep-think-tokens.png" width="280" /> | **الاستخدام والفوترة** | تفصيل الرموز لكل نموذج (إدخال / إخراج / تخزين مؤقت)، تكلفة بالدولار، رسوم بيانية شريطية ودائرية، فلاتر متعددة الأبعاد | اعرف أين تذهب رموزك وأموالك — قسّم حسب المستخدم والنموذج والنطاق الزمني، وفوترة الفرق بدقة |
| <img src="static/deep-think-about.png" width="280" /> | **حول** | الإصدار، معلومات البناء، روابط المشروع، فحوصات تحديث بنقرة واحدة | ابقَ على اطلاع — اعرف إصدار بنائك وانتقل مباشرة إلى الوثائق والمستودع وقنوات التحديث |

## البداية السريعة

### المتطلبات الأساسية

**إلزامي**: [Node.js](https://nodejs.org) >= 20، [Docker](https://www.docker.com/) (لوضع الحاوية؛ المسؤول في وضع المضيف لا يحتاجه)، ومفتاح Claude API (Anthropic الرسمي أو خدمة ترحيل متوافقة).

**اختياري**: بيانات اعتماد تطبيق Feishu، Telegram Bot Token، بيانات اعتماد QQ Bot، بيانات اعتماد DingTalk، رمز WeChat iLink، Discord Bot Token، WhatsApp (مسح رمز QR عند أول إطلاق) — فقط إذا أردت تكاملات المراسلة الفورية.

> لا تحتاج إلى تثبيت Claude Code CLI يدويًا — تبعية Claude Agent SDK في المشروع تتضمن runtime الكامل للـ CLI، ويُثبَّت تلقائيًا عند أول تشغيل لـ `make start`.

### التثبيت والتشغيل

```bash
# 1. استنساخ المستودع
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. بدء بأمر واحد (يثبّت التبعيات ويجمّع أول مرة)
make start
```

زر http://localhost:9898 واتبع معالج الإعداد: أنشئ المسؤول (لا يوجد حساب افتراضي)، هيّئ Claude API، واختياريًا هيّئ قنوات المراسلة. تتم كل التهيئة من واجهة Web دون أي ملفات تهيئة. تُخزَّن مفاتيح API مشفّرة بـ AES-256-GCM.

### تفعيل وضع الحاوية

يستخدم المسؤول افتراضيًا وضع المضيف (بدون Docker). إذا احتجت وضع الحاوية (يستخدمه المستخدمون الأعضاء تلقائيًا بعد التسجيل):

```bash
./container/build.sh
```

بعد التسجيل، يحصل كل مستخدم جديد تلقائيًا على مساحة عمل رئيسية بوضع الحاوية (`home-{userId}`)، دون تهيئة إضافية.

## نظرة عامة على البنية


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


يتكون DeepThink من أربعة مشاريع Node.js مستقلة:

- **الخلفية** (Node.js 22 + TypeScript 5.9 + Hono): الخدمة الرئيسية مع موجّه رسائل (اقتراع 2s + إزالة تكرار)، طابور تزامن (حتى 20 حاوية + 5 عمليات مضيف)، مجدول مهام (cron / interval / once)، خادم WebSocket للبث المباشر والطرفية، مصادقة bcrypt + HMAC Cookie، RBAC، وإدارة تهيئة مشفّرة بـ AES-256-GCM. البيانات في SQLite (وضع WAL، مخطط v1→v51). كما تتضمن طبقات Harness / Loop Engineering و Agent-as-a-Service (PaaS) و Sandbox و Claude Code Plugins.
- **الواجهة الأمامية** (`web/`): تطبيق صفحة واحدة بـ React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4، مع react-markdown و mermaid و recharts و xterm.js و PWA للجوال.
- **مشغّل الوكيل** (`container/agent-runner/`): محرك التنفيذ الذي يعمل داخل حاوية Docker أو كعملية مضيف؛ يستدعي `query()` من Claude Agent SDK، يبث أكثر من 30 نوعًا من StreamEvent عبر stdout، ويقدم 27 أداة MCP للعملية الرئيسية عبر قنوات IPC قائمة على الملفات مع كتابة ذرّية.
- **سطح المكتب** (`desktop/`): غلاف Electron يحزم تطبيقاً مستقلاً لـ macOS / Windows / Linux.

تدخل القنوات الثماني (Feishu، Telegram، QQ، DingTalk، WeChat، Discord، WhatsApp، Web) إلى الموجّه، تُزال تكرارها وتُوجَّه إلى الطابور، الذي يختار مفتاح API / محركًا عبر ProviderPool ويشغل حاوية أو عملية مضيف أو صندوق رمل. تُبَثّ أحداث البث عبر WebSocket إلى عملاء Web أو تُرد عبر واجهات برمجة تطبيقات المراسلة إلى كل قناة.

## الوثائق الكاملة

للحصول على الدليل الكامل، راجع:

- [النسخة الإنجليزية الكاملة](README.md)
- [النسخة الكاملة بـ 简体中文](README.zh-CN.md)

</div>

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

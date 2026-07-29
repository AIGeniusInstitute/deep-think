**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  ระบบ self-hosted หลายผู้ใช้แบบ local AI Agent Loop Engineering (เดสก์ท็อป + เบราว์เซอร์ + มือถือ) / Powered By AI Genius Institute
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


## DeepThink คืออะไร

DeepThink, แพลตฟอร์มสุดยอดปัญญาประดิษฐ์ Agent อิสระที่พัฒนาตนเองระดับองค์กร, ผู้บุกเบิกการเปลี่ยนผ่านจากพาราไดม์ Harness Engineering สู่ Loop Engineering, เป็นโครงสร้างพื้นฐาน AI (AI Infra) รุ่นใหม่สำหรับลูกค้าองค์กร แพลตฟอร์ม DeepThink ตั้งอยู่บนกรอบการทำงานร่วมกันแบบหลาย-Agent ผสานรวม AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop และ Human-Agent Symbiosis เพื่อสร้างระบบ AI ระดับองค์กรที่เรียนรู้อย่างต่อเนื่อง ปรับปรุงตนเอง และในที่สุดเติบโตเป็นสุดยอดปัญญาประดิษฐ์:

- **แพลตฟอร์ม R&D อิสระด้วย AI** — Agent ทำงานครบทั้งวงจรชีวิตการพัฒนาซอฟต์แวร์ได้อย่างอิสระ โดยไม่ต้องพึ่งพาวิศวกรมนุษย์ในงานเขียนโค้ดประจำ
- **เอนจิน Agent พัฒนาตนเอง** — Agent เรียนรู้จากข้อผิดพลาดอย่างต่อเนื่อง ดูดซับความรู้จากฐานโค้ด และวิวัฒน์การจากผลตอบรับของผู้ใช้
- **ศูนย์กลางการทำงานร่วมระหว่างโปรแกรมเมอร์และ Agent** — โปรแกรมเมอร์ทุกคนมี "โปรเจกต์การพัฒนา" ส่วนตัวที่มีหลายเซสชันคู่ขนาน ตัวกำหนดเวลากลางป้องกันความขัดแย้งแบบเกิดพร้อมกัน
- **แพลตฟอร์ม SaaS ระดับองค์กร** — การแยก multi-tenant, สิทธิ์แบบหลายระดับ, การเรียกเก็บเงินแบบยืดหยุ่น, และการเชื่อมต่อองค์กร (Feishu/DingTalk/WeCom/LDAP)
- **ตัวฟักไข่สุดยอดปัญญาประดิษฐ์** — ผ่านการวิวัฒน์การอย่างต่อเนื่อง Agent เดียวในที่สุดจะบรรลุความสามารถรอบด้านของทีมซอฟต์แวร์ที่สมบูรณ์

> "ขอให้ทุกองค์กรมีทีม R&D ซูเปอร์ AI ที่ไม่หยุดนิ่งและวิวัฒน์การอย่างต่อเนื่อง — จากผู้ใช้เครื่องมือ, สู่ผู้สร้างโค้ด, ในที่สุดเติบโตเป็นสุดยอดปัญญาประดิษฐ์ที่สร้างซ้ำตัวเองได้ ให้เราเดินไปด้วยกันบนเส้นทางสู่ AGI"

### คุณสมบัติเด่น

- **เอนจิน Claude Code แบบ native** — สร้างบน Claude Agent SDK, runtime ภายในคือ Claude Code CLI แบบเต็ม สืบทอดความสามารถทังหมด
- **Harness & Loop Engineering** — harness manifests แบบมีเวอร์ชัน (system prompt / subagents / tools / skills) พร้อม snapshot / diff / eval / promote / rollback และลูปงานอิสระระยะยาวที่มีการ review ต่อรอบและ re-inject ความล้มเหลว
- **Agent-as-a-Service (PaaS)** — สร้าง, กำหนดเวอร์ชัน, mount, แชร์ และติดตั้งนิยาม Agent ที่เก็บใน DB ข้าม tenant พร้อมโควตาต่อผู้ใช้, การตรวจสอบของ admin และตลาดแม่แบบที่เผยแพร่ได้
- **การแยกผู้ใช้หลายคน** — workspace ต่อผู้ใช้, ช่อง IM ต่อผู้ใช้, ระบบสิทธิ์ RBAC, การลงทะเบียนด้วยรหัสเชิญ และ audit log
- **routing แปดช่องแบบรวม** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp และอินเทอร์เฟซเว็บ — ทังหมด route แบบเหมือนกัน
- **หลายเอนจินและหลาย provider** — เอนจิน code-agent แบบปลั๊กอิน (Claude Code / AtomCode / Codex / OpenCode) และผู้ใหบริการ Claude API หลายรายพร้อมสามกลยุทธ์ load balancing (round-robin / weighted / failover) และ health check อัตโนมัติ
- **การรันโค้ดในแซนด์บอ็กซ์** — แซนด์บอ็กซ์ที่ hardening ด้วย Docker + seccomp + cgroups สำหรับรันโค้ด Python / Node / shell และอัตโนมัติเบราว์เซอร์ด้วย Chromium CDP
- **billing และสถิติการใช้งาน** — ระบบ billing ครบ (สมัครรับสมาชิก, กระเป๋าเงิน, รหัสแลกรางวัล), ติดตาม token ต่อโมเดลพร้อมกราฟ
- **PWA มือถือ** — ปรับให้เหมาะกับมือถืออย่างลึกซึ้ง, ติดตั้งหน้าจอหลักคลิกเดียว, รองรับ iOS / Android
- **หลายภาษา** — 29 ภาษาสำหรับ UI พร้อม endonym ดั้งเดิมและรองรับ RTL; Agent ตอบกลับในภาษาที่ผู้ใช้เลือก

## โชว์เคสฟีเจอร์

การแนะนำฟีเจอร์หลักของ DeepThink ผ่านภาพ — ดูว่าแต่ละหน้าจอเป็นอย่างไรและคุณค่าที่มอบให้ผู้ใช้มีอะไรบ้าง

| ภาพหน้าจอ | ฟีเจอร์ | ไฮไลต์หลัก | สิ่งนี้หมายถึงอะไรสำหรับคุณ |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **พื้นที่ทำงานหลัก** | แท็บสนทนาหลายช่อง, Markdown สตรีมมิ่ง, แผงความคิดแบบเรียลไทม์, การติดตามการเรียกใช้เครื่องมือ | พื้นที่ทำงานเดียวรองรับหลายแชทขนาน — สลับบริบทโดยไม่สูญเสียสถานะ, ดู Agent คิดและลงมือทำแบบสด |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | สร้าง / เก็บเวอร์ชัน / ติดตั้งนิยาม Agent แบบกำหนดเอง, พรีไฟล์ความสามารถของ host, การจัดการ snapshot | กำหนด Agent เฉพาะทางของคุณเอง (code-reviewer, web-researcher, …) แล้วนำกลับมาใช้ในทุกเซสชัน |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **ตัวแก้ไข Agent** | แก้ไข `~/.claude/agents/*.md` จาก Web UI, system-prompt + เครื่องมือ + subagents ในฟอร์มเดียว | ปรับพฤติกรรมของ Agent ด้วยภาษาธรรมดา — ไม่ต้องค้นไฟล์, การแก้ไขมีผลในเซสชันถัดไป |
| <img src="static/deep-think-agent-test.png" width="280" /> | **ทดสอบ Agent** | รัน Agent กับอินพุตตัวอย่างก่อนเผยแพร่, ตรวจสอบเอาต์พุตเต็มรูปแบบ | ส่งมอบ Agents อย่างมั่นใจ — ยืนยันพฤติกรรมบนเคสทดสอบก่อนปล่อยสู่การใช้งานจริง |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **มัลติเอนจิน** | เอนจินแบบปลั๊กอิน (Claude Code / AtomCode / Codex / OpenCode), แดชบอร์ดความพร้อมใช้งานแบบรวม | เลือกสมองที่ดีที่สุดสำหรับแต่ละงาน — สลับเอนจินต่อเซสชันโดยไม่ต้องรื้อสถาปัตยกรรมแพลตฟอร์ม |
| <img src="static/deep-think-engine-config.png" width="280" /> | **ตั้งค่าเอนจิน** | วงจรชีวิต daemon ระดับเอนจิน, ข้อมูลประจำตัวของ provider, สถานะความสมบูรณ์มองเห็นได้ในพื้นที่เดียว | รัน provider หลายตัวคู่กัน — เพิ่มข้อมูลประจำตัว, ตรวจสอบความพร้อม, และรองรับข้อผิดพลาดแบบอัตโนมัติ |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **AtomCode Engine** | daemon HTTP/SSE แบบสแตนด์อะโลน, พอร์ต loopback ต่อ agent-runner, รื้อถอนอัตโนมัติ | ใช้ AtomCode เป็นเอนจินเขียนโค้ดทางเลือก — daemon แยกขาดต่อโพรเซส, ไม่ชนพอร์ต |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | เทมเพลตที่ admin เผยแพร่ได้ (agent / mcp / skill / kb), เรียกดู, ให้คะแนน, ติดตั้งด้วยคลิกเดียว | ค้นพบและติดตั้ง Agents และเครื่องมือที่แชร์กันเหมือน app store — admin คัดสรร, ผู้ใช้ติดตั้งด้วยคลิกเดียว |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | MCP Servers แบบ stdio + HTTP ต่อพื้นที่ทำงาน, ไม่ขึ้นกับ config รวม | มอบชุดเครื่องมือเฉพาะให้แต่ละพื้นที่ทำงาน — เชื่อม Notion, GitHub, ฐานข้อมูล… โดยจำกัดขอบเขตที่โปรเจกต์นั้น |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills ระดับโปรเจกต์ / ผู้ใช้ / พื้นที่ทำงาน, ค้นพบอัตโนมัติผ่าน volume mount + symlink | สอนเทรดใหม่ให้ Agent ต่อโปรเจกต์ — ไม่ต้องสร้างอิมเมจใหม่, skills ปรากฏในเซสชันถัดไป |
| <img src="static/deep-think-memory.png" width="280" /> | **ระบบความจำ** | ความจำรวมผู้ใช้ / เซสชัน / วัน, ค้นหาเต็มข้อความ, แก้ไขออนไลน์ | Agent จดจำคุณข้ามเซสชัน — เรียกความชอบ, บริบทโปรเจกต์, และการตัดสินใจโดยไม่ต้องอธิบายซ้ำ |
| <img src="static/deep-think-cron-task.png" width="280" /> | **งานตั้งเวลา** | Cron / ช่วง / ครั้งเดียว, รันแบบ Agent หรือ Script, บริบทแบบกลุ่มหรือแยก, แจ้งเตือนทาง IM เมื่อเสร็จ | อัตโนมัติงานประจำ — รายงานยามค่ำคืน, ตรวจสอบเป็นช่วง, ลูปทำงานเองที่ส่งแจ้งเตือนบน Feishu/Telegram เมื่อเสร็จ |
| <img src="static/deep-think-sandbox.png" width="280" /> | **การรันใน Sandbox** | Docker + seccomp + cgroups, โค้ด Python / Node / shell, ออโตเมชันเบราว์เซอร์ Chromium CDP | ให้ Agent รันโค้ดที่ไม่น่าไว้วางใจและขับเบราว์เซอร์อย่างปลอดภัย — การแยกขาดแบบเข้มงวด, เปิดเป็นเครื่องมือ MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **มอนิเตอร์ระบบ** | รายชื่อคอนเทนเนอร์, สถานะคิว, เซสชันใช้งานต่อ provider, ตรวจสอบสุขภาพ, สร้างอิมเมจด้วยคลิกเดียว | เห็นชัดว่าอะไรกำลังรันอยู่ — สังเกตคอนเทนเนอร์ที่ค้าง, สมดุลโหลด, และสร้างอิมเมจใหม่จากเบราว์เซอร์ |
| <img src="static/deep-think-tokens.png" width="280" /> | **การใช้งานและการเรียกเก็บเงิน** | สรุปโทเคนต่อโมเดล (อินพุต / เอาต์พุต / แคช), ราคา USD, กราฟแท่ง + กราฟวงกลม, ตัวกรองหลายมิติ | รู้ว่าโทเคนและเงินของคุณไปอยู่ที่ไหน — แบ่งตามผู้ใช้, โมเดล, และช่วงเวลา, เรียกเก็บเงินทีมได้แม่นยำ |
| <img src="static/deep-think-about.png" width="280" /> | **About** | เวอร์ชัน, ข้อมูลบิลด์, ลิงก์โปรเจกต์, ตรวจสอบอัปเดตด้วยคลิกเดียว | อยู่ทันสมัย — ดูเวอร์ชันบิลด์ของคุณและกระโดดตรงสู่เอกสาร, รีโป, และช่องอัปเดต |

## เริ่มต้นอย่างรวดเร็ว

### ข้อกำหนดเบื้องต้น

**จำเป็น**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (สำหรับโหมด container; ไม่จำเป็นสำหรับโหมด host ของ admin), คีย์ Claude API (Anthropic ทางการหรือบริการ relay ที่เข้ากันได้)

**ไม่บังคับ**: ข้อมูลประจำตัวแอป enterprise Feishu, Telegram Bot Token, ข้อมูลประจำตัว QQ Bot, ข้อมูลประจำตัว DingTalk, โทเค็น WeChat iLink, Discord Bot Token, WhatsApp (สแกน QR ครั้งแรกที่เปิดใช้งาน) — เฉพาะเมื่อต้องการเชื่อมต่อ IM

> ไม่ต้องติดตั้ง Claude Code CLI ด้วยตนเอง — การขึ้นต่อของโปรเจก Claude Agent SDK มี CLI runtime แบบเต็ม และติดตั้งอัตโนมัติที่ `make start` ครั้งแรก

### ติดตั้งและเริ่มต้น

```bash
# 1. clone repository
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. เริ่มด้วยคำสั่งเดียว (ครั้งแรกติดตั้ง dependencies + compile)
make start
```

เปิด http://localhost:9898 และทำตามวิซาร์ดติดตั้ง: สร้าง admin (ไม่มีบัญชี default), ตั้งค่า Claude API และช่อง IM หากจำเป็น ทุกอย่างตั้งค่าจากอินเทอร์เฟซเว็บ ไม่ต้องมีไฟล์ config คีย์ API เข้ารหัสด้วย AES-256-GCM

### เปิดใช้งานโหมด container

ผู้ใช้ admin ใช้โหมด host (ไม่ต้องมี Docker) เป็น default โหมด container จำเป็นสำหรับผู้ใช้ member (เปิดใช้งานอัตโนมัติหลังลงทะเบียน):

```bash
./container/build.sh
```

หลังลงทะเบียนผู้ใช้ใหม่, workspace หลักของโหมด container (`home-{userId}`) จะถูกสร้างอัตโนมัติ โดยไม่ต้องตั้งค่าเพิ่ม

## ภาพรวมสถาปัตยกรรม


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink ประกอบด้วยสี่โปรเจก Node.js อิสระ:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): เซิร์ฟเวอร์หลักที่มี message router (polling 2s + ตัดซ้ำ), concurrent queue (สูงสุด 20 container + 5 โปรเซส host), task scheduler (cron / interval / once), เซิร์ฟเวอร์ WebSocket สำหรับ streaming เรียลไทม์และเทอร์มินัล, การยืนยันตัว bcrypt + HMAC Cookie, RBAC และการจัดการ config เข้ารหัส AES-256-GCM. ข้อมูลใน SQLite (โหมด WAL, schema v1→v51). ยังรวมชั้น Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox และ Claude Code Plugins
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA พร้อม react-markdown, mermaid, recharts, xterm.js และ PWA มือถือ
- **Agent Runner** (`container/agent-runner/`): engine ปฏิบัติการที่รันใน Docker container หรือเป็นโปรเซส host; เรียก `query()` ของ Claude Agent SDK, emit กว่า 30 ประเภท StreamEvent ผ่าน stdout และมอบเครื่องมือ MCP 27 ตัวให้โปรเซสแม่ผ่าน file IPC แบบเขียน atomic
- **Desktop** (`desktop/`): Electron shell ที่บรรจุแอปแบบสแตนด์อะโลนสำหรับ macOS / Windows / Linux

ช่อง IM แปดช่อง (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) เข้าสู่ router, ถูกตัดซ้ำและ route เข้าคิว ซึ่งเลือกคีย์ API / engine ผ่าน provider pool แล้วเริ่ม container, โปรเซส host หรือแซนด์บอ็กซ์. สตรีมมิ่ง event ส่งไปยัง web clients ผ่าน WebSocket หรือกลับไปยังแต่ละช่องผ่าน IM API

## เอกสารฉบับสมบูรณ์

คู่มือฉบับสมบูรณ์มีที่นี่:

- [ฉบับสมบูรณ์ภาษาอังกฤษ](README.md)
- [ฉบับสมบูรณ์ 简体中文](README.zh-CN.md)

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

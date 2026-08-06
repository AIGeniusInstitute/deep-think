**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Sistem self-hosted berbilang pengguna untuk AI Agent Loop Engineering tempatan (desktop + pelayar + mudah alih) / Powered By AI Genius Institute
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


## Apa itu DeepThink

DeepThink, platform evolusi-diri superinteligensi Agent autonomi gred enterprise, perintis transisi dari paradigma Harness Engineering ke Loop Engineering, ialah generasi baru Infrastruktur AI (AI Infra) untuk pelanggan enterprise. Platform DeepThink berpusatkan rangka kerja kerjasama berbilang-Agent, menggabungkan AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop dan Human-Agent Symbiosis untuk membina sistem AI gred enterprise yang sentiasa belajar, memperbaiki diri dan akhirnya membesar menjadi superinteligensi:

- **Platform R&D Autonomi AI** — Agent melengkapkan kitaran hayat pembangunan perisian penuh secara bebas, tanpa memerlukan jurutera manusia pada tugasan pengekodan rutin
- **Enjin Agent Evolusi-Diri** — Agent sentiasa belajar daripada ralat, menyerap pengetahuan daripada pangkalan kod, dan berevolusi daripada maklum balas pengguna
- **Hab Kerjasama Pengaturcara-Agent** — Setiap pengaturcara memiliki "Projek Pembangunan" peribadi yang mengandungi berbilang sesi selari, dan penjadwal pusat menghalang konflik konkurensi
- **Platform SaaS Enterprise** — Pemencilan berbilang-tenant, kebenaran berperingkat, pengebilan anjal, dan integrasi enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Inkubator Superinteligensi** — Melalui evolusi berterusan, satu Agent akhirnya mencapai keupayaan menyeluruh pasukan perisian lengkap

> "Semoga setiap enterprise memiliki pasukan R&D super AI yang tidak pernah berhenti dan terus berevolusi — daripada pengguna alat, kepada pencipta kod, akhirnya membesar menjadi superinteligensi yang mereplikasi diri. Mari berjalan bersama di jalan menuju AGI."

### Ciri utama

- **Enjin Claude Code natif** — berasaskan Claude Agent SDK, runtime dalaman ialah CLI Claude Code penuh, mewarisi semua keupayaannya
- **Harness & Loop Engineering** — manifest harness berversi (system prompt / subagents / tools / skills) dengan snapshot / diff / eval / promote / rollback, serta loop tugasan autonomi jangka panjang dengan semakan setiap lelaran dan suntikan semula kegagalan
- **Autonomy Layer dan Autonomous Mode** *(v1.1.0)* — Autonomy Layer melintasi sistem menyatukan 7 keupayaan (perception / cognition / decision / execution / learning / adaptation / monitoring) dengan metrics collection dan E2E acceptance; tambah Autonomous Mode penuh yang membolehkan Agent menyelesaikan tugas end-to-end tanpa bimbingan manusia, meliputi three defense layers (CLAUDE.md pembatalan perlembagaan / Supervisor pintasan penjelasan / RLHF kesopanan hujung giliran) dan four hard brakes (arahan memusnahkan / had giliran / had token / pengesanan gelung)
- **Agent-as-a-Service (PaaS)** — cipta, versi, lekap, kongsi dan pasang definisi Agent berasaskan pangkalan data merentasi tenant, dengan kuota setiap pengguna, semakan pentadbir dan pasaran templat boleh terbit
- **Pencilan berbilang pengguna** — workspace setiap pengguna, saluran IM setiap pengguna, sistem kebenaran RBAC, pendaftaran kod jemputan dan log audit
- **Penghalaan lapan saluran disatukan** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp dan antara muka web — semuanya dihalakan secara seragam
- **Berbilang enjin dan berbilang penyedia** — enjin ejen kod boleh palam (Claude Code / AtomCode / Codex / OpenCode) dan berbilang penyedia Claude API dengan tiga strategi imbangan beban (round-robin / weighted / failover), pengesanan kesihatan automatik
- **Pelaksanaan kod bersandbox** — sandbox Docker + seccomp + cgroups yang dikeraskan untuk pelaksanaan kod Python / Node / shell dan automasi pelayar Chromium CDP
- **Pengebilan dan statistik penggunaan** — sistem pengebilan penuh (langganan, dompet, kod penebusan), penjejakan token setiap model dengan visualisasi carta
- **PWA mudah alih** — dioptimumkan untuk mudah alih, pemasangan ke skrin rumah dengan satu ketik, disesuaikan untuk iOS / Android
- **Antarabangsa** — 29 bahasa UI dengan endonim natif dan sokongan RTL; Agent membalas dalam bahasa yang dipilih pengguna

## Galakan Ciri

Panduan visual keupayaan teras DeepThink — rupa setiap skrin dan nilai yang ia berikan kepada pengguna.

| Tangkap layar | Ciri | Sorotan Utama | Apa maknanya untuk anda |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Ruang Kerja Utama** | Tab berbilang perbualan, Markdown strim, panel pemikiran masa nyata, penjejakan panggilan alat | Satu ruang kerja memuatkan banyak sembang selari — tukar konteks tanpa kehilangan keadaan, tengok Agent berfikir dan bertindak secara langsung |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Studio Agent** | Cipta / versi / lekap definisi Agent tersuai, pra-tapis keupayaan hos, pengurusan snapshot | Takrifkan Agent pakar anda sendiri (code-reviewer, web-researcher, …) dan guna semula di setiap sesi |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Editor Agent** | Edit `~/.claude/agents/*.md` dari Web UI, system-prompt + alat + subagents dalam satu borang | Laras tingkah laku Agent dalam bahasa biasa — tanpa gali fail, perubahan berkenan pada sesi seterusnya |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Uji Agent** | Jalankan Agent terhadap input sampel sebelum terbit, periksa jejak output penuh | Hantar Agent dengan yakin — sahkan tingkah laku pada kes ujian sebelum lepaskannya dalam pengeluaran |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Enjin Berbilang** | Enjin boleh palam (Claude Code / AtomCode / Codex / OpenCode), papan pemuka ketersediaan bersatu | Pilih otak terbaik bagi setiap tugas — tukar enjin per sesi tanpa menambah baik senibina platform |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Konfigurasi Enjin** | Kitar hayat daemon per-enjin, kredensial provider, status kesihatan sekali pandang | Jalankan berbilang provider sebelah-menyebelah — tambah kredensial, pantau kemandirian, dan alih-gagal secara automatik |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **Enjin AtomCode** | Daemon HTTP/SSE mandiri, port loopback per-agent-runner, auto-roboh | Guna AtomCode sebagai enjin pengekodan alternatif — daemon terasing per proses, tiada konflik port |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Templat boleh terbit admin (agent / mcp / skill / kb), layari, nilai, pasang sekali-klik | Temui dan pasang Agent serta alat kongsi seperti gedung aplikasi — admin kurasi, pengguna pasang sekali-klik |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | MCP Servers stdio + HTTP per-ruang kerja, bebas daripada konfigurasi global | Beri setiap ruang kerja set alatnya sendiri — sambungkan Notion, GitHub, pangkalan data… ditakrif tepat ke projek itu |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills tahap projek / pengguna / ruang kerja, auto ditemui melalui lekap volum + pautan simbolik | Ajar Agent helah baharu setiap projek — tanpa bina semula imej, skills muncul dalam sesi seterusnya |
| <img src="static/deep-think-memory.png" width="280" /> | **Sistem Ingatan** | Ingatan pengguna-global / sesi / tarikh, carian teks penuh, penyuntingan dalam talian | Agent mengingati anda merentasi sesi — panggil semula keutamaan, konteks projek, dan keputusan tanpa terangkan semula |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Tugas Terjadual** | Cron / selang / sekali sahaja, pelaksanaan Agent atau Skrip, konteks kumpulan atau terasing, pemberitahuan IM selepas selesai | Automatikkan kerja berulang — laporan malam, semakan berkala, gelung kendiri yang mengetuk anda di Feishu/Telegram bila siap |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Pelaksanaan Sandbox** | Docker + seccomp + cgroups, kod Python / Node / shell, automasi pelayar Chromium CDP | Biar Agent jalankan kod yang tidak dipercayai dan kawal pelayar dengan selamat — pencilan terkeras, didedahkan sebagai alat MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Monitor Sistem** | Senarai kontena, keadaan baris gilir, sesi aktif per-provider, semakan kesihatan, bina imej sekali-klik | Tengok sebenar-benarnya apa yang berjalan — kesan kontena tersekat, imbangkan beban, dan bina semula imej dari pelayar |
| <img src="static/deep-think-tokens.png" width="280" /> | **Penggunaan & Bil** | Pecahan token per-model (input / output / cache), kos USD, carta bar + pai, penapis berbilang dimensi | Tahu ke mana token dan wang anda pergi — potong mengikut pengguna, model, dan julat masa, bil pasukan dengan tepat |
| <img src="static/deep-think-about.png" width="280" /> | **About** | Versi, maklumat bina, pautan projek, semakan kemas kini sekali-klik | Kekini — lihat versi bina anda dan terus ke dokumentasi, repo, dan saluran kemas kini |

## Mula Cepat

### Prasyarat

**Wajib**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (untuk mod container; tidak diperlukan untuk mod host admin), kunci Claude API (Anthropic rasmi atau perkhidmatan relay serasi).

**Pilihan**: kredensial aplikasi perusahaan Feishu, Telegram Bot Token, kredensial QQ Bot, kredensial DingTalk, token WeChat iLink, Discord Bot Token, WhatsApp (imbasan QR pada pelancaran pertama) — hanya jika integrasi IM diperlukan.

> Tidak perlu memasang Claude Code CLI secara manual — kebergantungan Claude Agent SDK projek merangkumi runtime CLI penuh, dipasang automatik pada `make start` pertama.

### Pemasangan dan pelancaran

```bash
# 1. Klon repositori
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Pelancaran satu arahan (pemasangan pertama kebergantungan + kompilasi)
make start
```

Buka http://localhost:9898 dan ikuti wizard pemasangan: cipta pentadbir (tiada akaun lalai), konfigurasi Claude API dan saluran IM jika perlu. Semuanya dikonfigurasi dari antara muka web, tiada fail konfigurasi. Kunci API disulitkan dengan AES-256-GCM.

### Pengaktifan mod container

Pengguna admin secara lalai menggunakan mod host (tanpa Docker). Mod container diperlukan untuk pengguna member (diaktifkan automatik selepas pendaftaran):

```bash
./container/build.sh
```

Selepas pendaftaran pengguna baharu, workspace utama mod container (`home-{userId}`) dicipta secara automatik, tanpa konfigurasi tambahan.

## Gambaran keseluruhan senibina


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink terdiri daripada empat projek Node.js bebas:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): perkhidmatan utama dengan penghala mesej (polling 2s + nyahpendua), baris gilir serentak (maksimum 20 container + 5 proses host), penjadual tugas (cron / interval / once), pelayan WebSocket untuk penstriman masa nyata dan terminal, pengesahan bcrypt + HMAC Cookie, RBAC, dan pengurusan konfigurasi tersulit AES-256-GCM. Penerusan SQLite (mod WAL, schema v1→v51). Ia juga merangkumi lapisan Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox dan Claude Code Plugins.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, dengan react-markdown, mermaid, recharts, xterm.js dan PWA mudah alih.
- **Agent Runner** (`container/agent-runner/`): enjin pelaksanaan yang berjalan dalam container Docker atau sebagai proses host; ia memanggil `query()` Claude Agent SDK, memancarkan 30+ jenis StreamEvent melalui stdout dan menyediakan 27 alat MCP kepada proses induk melalui saluran IPC berasaskan fail dengan tulisan atomik.
- **Desktop** (`desktop/`): cangkang Electron yang mempakej aplikasi mandiri untuk macOS / Windows / Linux.

Lapan saluran IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) memasuki penghala, dinyahpendua dan dihalakan ke baris gilir, yang memilih kunci API / enjin melalui kolam penyedia dan melancarkan container, proses host atau sandbox. Acara penstriman disiarkan melalui WebSocket ke klien web atau dibalas melalui API IM ke setiap saluran.

## Dokumentasi penuh

Panduan penuh tersedia di sini:

- [Versi penuh Bahasa Inggeris](README.md)
- [Versi penuh 简体中文](README.zh-CN.md)

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

**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Self-hosted çok kullanıcılı yerel AI Agent Loop Engineering sistemi (masaüstü + tarayıcı + mobil) / Powered By AI Genius Institute
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


## DeepThink Nedir

DeepThink, kurumsal düzeyde özerk Agent kendi-evrilen süper-zeka platformu; Harness Engineering'den Loop Engineering paradigmasına geçişin öncüsü; kurumsal müşteriler için yeni nesil AI Altyapısıdır (AI Infra). DeepThink platformu çok-Agent işbirliği çerçevesini merkeze alır; AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop ve Human-Agent Symbiosis'i harmanlayarak sürekli öğrenen, kendini geliştiren ve nihayetinde süper-zekaya dönüşen kurumsal bir AI sistemi inşa eder:

- **AI Özerk Ar-Ge Platformu** — Agent'lar yazılım geliştirme yaşam döngüsünün tamamını bağımsız olarak tamamlar; rutin kodlama görevlerinde insan mühendislere ihtiyaç duymaz
- **Kendi-Evrilen Agent Motoru** — Agent'lar hatalardan sürekli öğrenir, kod tabanından bilgi emer ve kullanıcı geri bildirimlerinden evrilir
- **Programcı-Agent İşbirliği Merkezi** — Her programcının birden çok paralel oturum içeren kişisel bir "Geliştirme Projesi" vardır; merkezi zamanlayıcı eşzamanlılık çakışmalarını önler
- **Kurumsal SaaS Platformu** — Çok-kiracılı izolasyon, katmanlı izinler, esnek faturalama ve kurumsal entegrasyonlar (Feishu/DingTalk/WeCom/LDAP)
- **Süper-zeka Kuluçka Makinesi** — Sürekli evrim yoluyla, tek bir Agent nihayetinde eksiksiz bir yazılım ekibinin kapsamlı yeteneklerine erişir

> "Her kuruluş, asla durmayan, sürekli evrilen bir AI süper Ar-Ge ekibine sahip olsun — araç kullanıcısından, kod yaratıcısına, nihayetinde kendini çoğaltan bir süper-zekaya büyüyerek. AGI'ye giden yolda birlikte yürüyelim."

### Ana özellikler

- **Yerel Claude Code tabanlı** — Claude Agent SDK üzerine inşa edilmiştir, altında tam Claude Code CLI runtime'ı yer alır ve tüm yeteneklerini miras alır
- **Harness & Loop Engineering** — Sürümlü harness manifestleri (sistem promptu / sub-agent'lar / araçlar / yetenekler) ile snapshot / diff / eval / promote / geri alma; ayrıca her yinelemede inceleme ve hata enjeksiyonu içeren uzun süreli özerk görev döngüleri
- **Agent-as-a-Service (PaaS)** — Veritabanı destekli Agent tanımlarını kiracılar arasında oluşturma, sürümlendirme, mount etme, paylaşma ve kurma; kullanıcı başına kota, admin incelemesi ve yayınlanabilir şablon pazarı
- **Çok kullanıcılı izolasyon** — Kullanıcı başına workspace, kullanıcı başına IM kanalları, RBAC yetki sistemi, davet kodu kaydı ve denetim günlükleri
- **Sekiz kanal birleşik yönlendirme** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp ve web arayüzü — hepsi tek tip yönlendirilir
- **Çok motorlu ve çok sağlayıcılı** — Takılabilir kod-agent motorları (Claude Code / AtomCode / Codex / OpenCode) ve üç yük dengeleme stratejili (round-robin / weighted / failover) birden fazla Claude API sağlayıcısı, otomatik sağlık algılama
- **Korumalı alanda kod yürütme** — Python / Node / shell kod yürütme ve Chromium CDP tarayıcı otomasyonu için Docker + seccomp + cgroups ile sertleştirilmiş sandbox
- **Faturalama ve kullanım istatistikleri** — Tam faturalama sistemi (abonelik planları, cüzdan bakiyesi, kullanım kodları), model başına token kullanım takibi ve grafik görselleştirmeleri
- **Mobil PWA** — Mobil için derinlemesine optimize, ana ekrana tek dokunuşla kurulum, iOS / Android uyumlu
- **Uluslararası** — 29 UI dili, doğağınızla yazım ve RTL desteği; Agent kullanıcının seçtiği dilde yanıt verir

## Özellik Vitrini

DeepThink'ın temel yeteneklerinin görsel bir turu — her ekranın nasıl göründüğü ve kullanıcıya sağladığı değer.

| Ekran Görüntüsü | Özellik | Temel Öne Çıkanlar | Sizin için ne anlama gelir |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Ana Çalışma Alanı** | Çoklu konuşma sekmeleri, akış Markdown, gerçek zamanlı düşünme paneli, araç çağırma izleme | Tek çalışma alanı birçok paralel sohbeti barındırır — bağlamı kaybetmeden değiştirin, Agent'ın düşünmesini ve canlı hareket etmesini izleyin |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Özel Agent tanımları oluşturma / sürümleme / bağlama, sunucu yeteneği ön kontrolü, anlık görüntü yönetimi | Kendi uzman Agent'larınızı tanımlayın (code-reviewer, web-researcher, …) ve her oturumda yeniden kullanın |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Agent Editörü** | `~/.claude/agents/*.md` dosyalarını Web arayüzünden düzenleme, sistem komutu + araçlar + alt agent'lar tek formda | Bir Agent'ın davranığını düz dilde ayarlayın — dosya kazısı yok, değişiklikler sonraki oturumda uygulanır |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Agent Testi** | Bir Agent'ı yayımlamadan önce örnek girdilere karşı çalıştırma, tam çıktı izini inceleme | Agent'ları güvenle gönderin — üretimde serbest bırakmadan önce test vakaları üzerinde davranışı doğrulayın |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Çoklu Motor** | Takılabilir motorlar (Claude Code / AtomCode / Codex / OpenCode), birleşik kullanılabilirlik panosu | Her görev için en iyi beyni seçin — platformu yeniden mimarileştirmeden oturum başına motor değiştirin |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Motor Yapılandırması** | Motor başına daemon yaşam döngüsü, sağlayıcı kimlik bilgileri, sağlık durumu tek bakışta | Birden çok sağlayıcıyı yan yana çalıştırın — kimlik bilgileri ekleyin, canlılığı izleyin ve otomatik olarak yük devredin |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **AtomCode Motoru** | Bağımsız HTTP/SSE daemon, agent-runner başına geri döngü bağlantı noktası, otomatik sökme | AtomCode'u alternatif bir kodlama motoru olarak kullanın — süreç başına izole daemon, bağlantı noktası çakışması yok |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Yönetici tarafından yayımlanabilir şablonlar (agent / mcp / skill / kb), gezinme, değerlendirme, tek tıkla yükleme | Paylaşılan Agent'ları ve araçları bir uygulama mağazası gibi keşfedin ve yükleyin — yöneticiler seçer, kullanıcılar tek tıkla yükler |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Sunucuları** | Çalışma alanı başına stdio + HTTP MCP Sunucuları, global yapılandırmadan bağımsız | Her çalışma alanına kendi araç setini verin — Notion, GitHub, veritabanları… bağlayın, tam olarak o projeye kapsamlı |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Proje / kullanıcı / çalışma alanı düzeyinde Skills, hacim bağlama + sembolik bağlantılar ile otomatik keşfedilir | Agent'a proje başına yeni numaralar öğretin — imaj yeniden derleme yok, skill'ler sonraki oturumda belirir |
| <img src="static/deep-think-memory.png" width="280" /> | **Bellek Sistemi** | Kullanıcı-global / oturum / tarih belleği, tam metin arama, çevrimiçi düzenleme | Agent sizin hatırlar — tercihler, proje bağlamı ve kararları yeniden açıklamadan geri çağırır |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Zamanlanmış Görevler** | Cron / aralık / tek seferlik, Agent veya Script yürütme, grup veya izole bağlam, tamamlandığında IM bildirimi | Yinelenen işleri otomatikleştirin — gecelik raporlar, periyodik kontroller, tamamlandığında sizi Feishu/Telegram üzerinden pinglayan kendi kendine çalışan döngüler |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Korumalı Yürütme** | Docker + seccomp + cgroups, Python / Node / shell kodu, Chromium CDP tarayıcı otomasyonu | Agent'ın güvenilmeyen kodu çalıştırmasına ve güvenli bir şekilde tarayıcı sürmesine izin verin — sertleştirilmiş izolasyon, MCP araçları olarak sunulur |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Sistem İzleyici** | Konteyner listesi, kuyruk durumu, sağlayıcı başına etkin oturumlar, sağlık kontrolleri, tek tıkla imaj derleme | Tam olarak neyin çalıştığını görün — takılı konteynerleri tespit edin, yükü dengeleyin ve imajları tarayıcıdan yeniden derleyin |
| <img src="static/deep-think-tokens.png" width="280" /> | **Kullanım ve Faturalama** | Model başına token dökümü (girdi / çıktı / önbellek), USD maliyet, çubuk + pasta grafikler, çok boyutlu filtreler | Token'larınızın ve paranızın nereye gittiğini bilin — kullanıcı, model ve zaman aralığına göre dilimleyin, ekipleri doğru faturalandırın |
| <img src="static/deep-think-about.png" width="280" /> | **Hakkında** | Sürüm, derleme bilgisi, proje bağlantıları, tek tıkla güncelleme kontrolleri | Güncel kalın — derleme sürümünüzü görün ve doğrudan dokümanlara, depoya ve güncelleme kanallarına atlayın |

## Hızlı Başlangıç

### Ön koşullar

**Zorunlu**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (container modu için; admin host modu için gerekli değil), Claude API anahtarı (resmi Anthropic veya uyumlu relay servisi).

**İsteğe bağlı**: Feishu kurumsal uygulama kimlik bilgileri, Telegram Bot Token, QQ Bot kimlik bilgileri, DingTalk kimlik bilgileri, WeChat iLink token, Discord Bot Token, WhatsApp (ilk başlatmada QR tarama) — yalnızca IM entegrasyonu gerekliyse.

> Claude Code CLI'ı manuel olarak kurmanız gerekmez — projenin Claude Agent SDK bağımlılığı tam CLI runtime'ını içerir ve ilk `make start`'ta otomatik kurulur.

### Kurulum ve başlatma

```bash
# 1. Repoyu klonla
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Tek komutla başlat (ilk seferde bağımlılıkları kurar + derler)
make start
```

http://localhost:9898 adresini açın ve kurulum sihirbazını izleyin: yönetici oluşturun (varsayılan hesap yok), Claude API'yi yapılandırın ve gerekirse IM kanallarını ayarlayın. Her şey web arayüzünden yapılandırılır, yapılandırma dosyası gerekmez. API anahtarları AES-256-GCM ile şifrelenir.

### Container modunu etkinleştirme

Admin kullanıcısı varsayılan olarak host modunu (Docker olmadan) kullanır. Container modu member kullanıcıları için gerekir (kayıttan sonra otomatik etkinleşir):

```bash
./container/build.sh
```

Yeni kullanıcı kaydından sonra, container modunun ana workspace'i (`home-{userId}`) otomatik olarak oluşturulur, ek yapılandırma olmadan.

## Mimariye Genel Bakış


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink dört bağımsız Node.js projesinden oluşur:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): mesaj yönlendirici (2s polling + yinelenenleri kaldırma), eşzamanlı kuyruk (en fazla 20 container + 5 host süreci), görev zamanlayıcı (cron / interval / once), gerçek zamanlı akış ve terminal için WebSocket sunucusu, bcrypt + HMAC Cookie kimlik doğrulama, RBAC ve AES-256-GCM şifreli yapılandırma yönetimi. SQLite kalıcılığı (WAL modu, şema v1→v51). Ayrıca Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox ve Claude Code Plugins katmanlarını içerir.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, react-markdown, mermaid, recharts, xterm.js ve mobil PWA.
- **Agent Runner** (`container/agent-runner/`): Docker container'ında veya host süreci olarak çalışan yürütme motoru; Claude Agent SDK'nın `query()` fonksiyonunu çağırır, stdout üzerinden 30+ StreamEvent türü yayar ve atomik yazımlı dosya tabanlı IPC kanalları üzerinden üst sürece 27 MCP aracını sunar.
- **Desktop** (`desktop/`): macOS / Windows / Linux için tek başına çalışabilen uygulamayı paketleyen Electron kabuğu.

Sekiz IM kanalı (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) yönlendiriciye girer, yinelenenlerden arındırılır ve kuyruğa alınır; kuyruk ProviderPool üzerinden bir API anahtarı / motor seçer ve bir container, host süreci veya sandbox başlatır. Akış olayları WebSocket ile web istemcilerine veya IM API'leri ile her kanala geri yanıtlanır.

## Tam Dokümantasyon

Tam kılavuzu burada bulabilirsiniz:

- [İngilizce tam sürüm](README.md)
- [简体中文 tam sürüm](README.zh-CN.md)

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

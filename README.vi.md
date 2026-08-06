**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  Hệ thống self-hosted đa người dùng AI Agent Loop Engineering nội bộ (desktop + trình duyệt + di động) / Powered By AI Genius Institute
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


## DeepThink là gì

DeepThink, nền tảng siêu trí tuệ tự tiến hóa Agent tự chủ cấp doanh nghiệp, nhà tiên phong trong chuyển dịch từ mô hình Harness Engineering sang Loop Engineering, là thế hệ mới của Hạ tầng AI (AI Infra) dành cho khách hàng doanh nghiệp. Nền tảng DeepThink lấy khung cộng tác đa-Agent làm trung tâm, kết hợp AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop và Human-Agent Symbiosis để xây dựng một hệ thống AI cấp doanh nghiệp liên tục học hỏi, tự cải thiện và cuối cùng phát triển thành siêu trí tuệ:

- **Nền tảng R&D tự chủ bằng AI** — Agent độc lập hoàn thành toàn bộ vòng đời phát triển phần mềm, không cần kỹ sư con người trong các tác vụ mã hóa thường lệ
- **Động cơ Agent tự tiến hóa** — Agent liên tục học từ lỗi, hấp thụ tri thức từ cơ sở mã, và tiến hóa từ phản hồi người dùng
- **Trung tâm cộng tác Lập trình viên-Agent** — Mỗi lập trình viên sở hữu một "Dự án Phát triển" cá nhân chứa nhiều phiên song song, bộ lập lịch trung tâm ngăn xung đột đồng thời
- **Nền tảng SaaS doanh nghiệp** — Cô lập multi-tenant, quyền hạn theo tầng, thanh toán linh hoạt, tích hợp doanh nghiệp (Feishu/DingTalk/WeCom/LDAP)
- **Ấp ủ siêu trí tuệ** — Thông qua tiến hóa liên tục, một Agent duy nhất cuối cùng đạt được năng lực toàn diện của một đội phần mềm hoàn chỉnh

> "Mong mỗi doanh nghiệp sở hữu một đội R&D siêu AI không bao giờ dừng lại và liên tục tiến hóa — từ người dùng công cụ, sang người kiến tạo mã, cuối cùng phát triển thành siêu trí tuệ tự tái tạo. Hãy cùng bước trên con đường tiến tới AGI."

### Tính năng chính

- **Engine Claude Code gốc** — Xây trên Claude Agent SDK, runtime bên dưới là toàn bộ Claude Code CLI, kế thừa mọi năng lực
- **Harness & Loop Engineering** — Manifest harness có versioning (system prompt / subagents / tools / skills) với snapshot / diff / eval / promote / rollback, cùng vòng lặp tác vụ tự chủ dài hạn có review từng vòng và re-inject khi thất bại
- **Autonomy Layer và Autonomous Mode** *(v1.1.0)* — Một Autonomy Layer xuyên suốt hợp nhất 7 năng lực (perception / cognition / decision / execution / learning / adaptation / monitoring) với metrics collection và E2E acceptance; plus một Autonomous Mode trọn vẹn cho phép Agent hoàn thành tác vụ end-to-end không cần con người kèm cặp, bao phủ three defense layers (CLAUDE.md ghi đè hiến chương / Supervisor bỏ qua làm rõ / RLHF lịch sự cuối lượt) và four hard brakes (lệnh phá hủy / giới hạn lượt / giới hạn token / phát hiện vòng lặp)
- **Agent-as-a-Service (PaaS)** — Tạo, version, mount, chia sẻ và cài đặt các định nghĩa Agent lưu DB giữa các tenant, với quota per-user, review admin, và marketplace template có thể publish
- **Cách ly đa người dùng** — Workspace per-user, kênh IM per-user, hệ thống quyền RBAC, đăng ký bằng mã mời, nhật ký kiểm toán
- **Định tuyến tám kênh thống nhất** — Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, và giao diện web — đều được định tuyến đồng nhất
- **Đa engine & đa provider** — Engine agent mã pluggable (Claude Code / AtomCode / Codex / OpenCode) và nhiều provider Claude API với ba chiến lược cân bằng tải (round-robin / weighted / failover), health check tự động
- **Thực thi mã trong sandbox** — Sandbox Docker + seccomp + cgroups tăng cứng cho thực thi mã Python / Node / shell và tự động hóa trình duyệt Chromium CDP
- **Billing và thống kê sử dụng** — Hệ thống billing đầy đủ (gói đăng ký, số dư ví, mã đổi thưởng), theo dõi token theo mô hình với biểu đồ trực quan
- **PWA di động** — Tối ưu sâu cho di động, cài đặt màn hình chính một chạm, tương thích iOS / Android
- **Quốc tế hóa** — 29 ngôn ngữ UI với endonym bản địa và hỗ trợ RTL; Agent trả lời theo ngôn ngữ người dùng chọn

## Trưng bày Tính năng

Hướng dẫn trực quan về các khả năng cốt lõi của DeepThink — mỗi màn hình trông như thế nào và giá trị nó mang lại cho người dùng.

| Ảnh chụp | Tính năng | Điểm nổi bật cốt lõi | Ý nghĩa đối với bạn |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Không gian làm việc chính** | Nhiều tab hội thoại, Markdown trực tuyến, bảng suy nghĩ thời gian thực, truy vết lời gọi công cụ | Một không gian chứa nhiều đoạn chat song song — chuyển ngữ cảnh mà không mất trạng thái, theo dõi Agent suy nghĩ và hành động trực tiếp |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Tạo / đánh phiên bản / gắn định nghĩa Agent tùy biến, kiểm tra tiền định khả năng máy chủ, quản lý snapshot | Định nghĩa các Agent chuyên môn riêng (code-reviewer, web-researcher…) và tái sử dụng trên mọi phiên |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Agent Editor** | Chỉnh sửa `~/.claude/agents/*.md` ngay từ Web UI, system prompt + công cụ + subagent trong một biểu mẫu | Tinh chỉnh hành vi Agent bằng ngôn ngữ tự nhiên — không cần lục file, thay đổi có hiệu lực ở phiên sau |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Kiểm thử Agent** | Chạy Agent với đầu vào mẫu trước khi phát hành, xem toàn bộ vết đầu ra | Triển khai Agent tự tin — kiểm chứng hành vi trên test case trước khi thả vào sản xuất |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Đa Engine** | Engine cắm được (Claude Code / AtomCode / Codex / OpenCode), bảng sẵn sàng thống nhất | Chọn bộ não phù hợp cho từng tác vụ — đổi engine theo phiên mà không cần kiến trúc lại nền tảng |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Cấu hình Engine** | Vòng đời daemon theo engine, thông tin xác thực provider, tình trạng sức khỏe ngay trước mắt | Chạy nhiều provider song song — thêm thông tin xác thực, giám sát tồn tại, tự động chuyển đổi khi sự cố |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **AtomCode Engine** | Daemon HTTP/SSE độc lập, cổng loopback từng agent-runner, tự tháo dỡ | Dùng AtomCode làm engine lập trình thay thế — daemon độc lập mỗi tiến trình, không xung đột cổng |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Mẫu do admin xuất bản (agent / mcp / skill / kb), duyệt, đánh giá, cài một chạm | Khám và cài Agent cùng công cụ chia sẻ như kho ứng dụng — admin tuyển chọn, người dùng cài trong một chạm |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | MCP Servers stdio + HTTP theo không gian làm việc, độc lập với cấu hình toàn cục | Cấp cho mỗi không gian một bộ công cụ riêng — kết nối Notion, GitHub, cơ sở dữ liệu… phạm vi giới hạn đúng dự án đó |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Skills cấp dự án / người dùng / không gian, tự động phát hiện qua volume mount + symlink | Dạy Agent kỹ năng mới theo dự án — không cần build lại image, skill xuất hiện ở phiên sau |
| <img src="static/deep-think-memory.png" width="280" /> | **Hệ thống Trí nhớ** | Trí nhớ người dùng toàn cục / phiên / theo ngày, tìm kiếm toàn văn, chỉnh sửa trực tuyến | Agent nhớ bạn xuyên suốt các phiên — gọi lại sở thích, ngữ cảnh dự án và quyết định mà không phải giải thích lại |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Nhiệm vụ định lịch** | Cron / khoảng / một lần, thực thi Agent hoặc Script, ngữ cảnh nhóm hoặc cô lập, thông báo IM khi hoàn thành | Tự động hóa công việc định kỳ — báo cáo đêm, kiểm tra chu kỳ, vòng lặp tự chạy, báo bạn trên Feishu/Telegram khi xong |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Thực thi Sandbox** | Docker + seccomp + cgroups, mã Python / Node / shell, tự động hóa trình duyệt Chromium CDP | Để Agent chạy mã không tin cậy và điều khiển trình duyệt an toàn — cô lập được refor, lộ ra như công cụ MCP |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **Giám sát Hệ thống** | Danh sách container, trạng thái hàng đợi, phiên hoạt động theo provider, health check, build image một chạm | Nhìn rõ cái gì đang chạy — phát hiện container kẹt, cân bằng tải, build lại image từ trình duyệt |
| <img src="static/deep-think-tokens.png" width="280" /> | **Sử dụng & Thanh toán** | Phân tích token theo model (đầu vào / đầu ra / cache), chi phí USD, biểu đồ cột + tròn, bộ lọc đa chiều | Biết token và tiền đi đâu — cắt theo người dùng, model, khoảng thời gian, tính cự chính xác cho team |
| <img src="static/deep-think-about.png" width="280" /> | **Giới thiệu** | Phiên bản, thông tin build, liên kết dự án, kiểm tra cập nhật một chạm | Luôn cập nhật — xem phiên bản build và nhảy thẳng đến tài liệu, repo, kênh cập nhật |

## Bắt đầu nhanh

### Điều kiện trước

**Bắt buộc**: [Node.js](https://nodejs.org) >= 20, [Docker](https://www.docker.com/) (cho chế độ container; không cần cho chế độ host của admin), khóa Claude API (Anthropic chính thức hoặc dịch vụ relay tương thích).

**Tùy chọn**: thông tin xác thực ứng dụng doanh nghiệp Feishu, Telegram Bot Token, thông tin QQ Bot, thông tin DingTalk, token WeChat iLink, Discord Bot Token, WhatsApp (quét QR ở lần khởi động đầu tiên) — chỉ khi cần tích hợp IM.

> Không cần cài Claude Code CLI thủ công — phụ thuộc Claude Agent SDK của dự án đã bao gồm toàn bộ CLI runtime, được cài tự động ở lần `make start` đầu tiên.

### Cài đặt và khởi động

```bash
# 1. Clone repository
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Khởi động bằng một lệnh (lần đầu cài phụ thuộc + biên dịch)
make start
```

Mở http://localhost:9898 và làm theo hướng dẫn cài đặt: tạo admin (không có tài khoản mặc định), cấu hình Claude API và kênh IM nếu cần. Mọi thứ được cấu hình từ giao diện web, không cần tệp cấu hình. Khóa API được mã hóa bằng AES-256-GCM.

### Kích hoạt chế độ container

Người dùng admin mặc định dùng chế độ host (không cần Docker). Chế độ container cần cho người dùng member (tự động kích hoạt sau khi đăng ký):

```bash
./container/build.sh
```

Sau khi đăng ký người dùng mới, workspace chính ở chế độ container (`home-{userId}`) được tạo tự động, không cần cấu hình thêm.

## Tổng quan kiến trúc


<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


DeepThink gồm bốn dự án Node.js độc lập:

- **Backend** (Node.js 22 + TypeScript 5.9 + Hono): service chính với bộ định tuyến tin nhắn (polling 2s + khử trùng), hàng đợi đồng thời (tối đa 20 container + 5 quy trình host), bộ lập lịch tác vụ (cron / interval / once), máy chủ WebSocket cho streaming thời gian thực và terminal, xác thực bcrypt + HMAC Cookie, RBAC, quản lý cấu hình mã hóa AES-256-GCM. Dữ liệu trong SQLite (chế độ WAL, schema v1→v51). Còn bao gồm các tầng Harness / Loop Engineering, Agent-as-a-Service (PaaS), Sandbox, và Claude Code Plugins.
- **Frontend** (`web/`): React 19 + Vite 6 + Zustand 5 + Tailwind CSS 4 SPA, với react-markdown, mermaid, recharts, xterm.js, và PWA di động.
- **Agent Runner** (`container/agent-runner/`): engine thực thi chạy trong Docker container hoặc dưới dạng quy trình host. Gọi `query()` của Claude Agent SDK, phát hơn 30 loại StreamEvent qua stdout, và cung cấp 27 công cụ MCP cho quy trình cha qua kênh IPC tệp với ghi nguyên tử.
- **Desktop** (`desktop/`): vỏ Electron đóng gói ứng dụng standalone cho macOS / Windows / Linux.

Tám kênh IM (Feishu, Telegram, QQ, DingTalk, WeChat, Discord, WhatsApp, Web) đi vào router, được khử trùng và đưa vào hàng đợi, nơi ProviderPool chọn khóa API / engine và khởi động container, quy trình host, hoặc sandbox. Sự kiện streaming được phát tới Web clients qua WebSocket hoặc trả lời qua IM API tới từng kênh.

## Tài liệu đầy đủ

Hướng dẫn đầy đủ có tại đây:

- [Phiên bản đầy đủ tiếng Anh](README.md)
- [Phiên bản đầy đủ 简体中文](README.zh-CN.md)

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

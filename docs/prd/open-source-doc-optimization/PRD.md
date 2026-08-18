# DeepThink 开源文档系统优化 — PRD

> 仓库名澄清：实际仓库为 `AIGeniusInstitute/deepthink`（无连字符）。本需求中多处"deep-think"均指拼写错误。

## 1. 背景

DeepThink 是面向企业的自托管 AI Agent Loop Engineering 平台，已有 30 种语言 README、完整的截图展示、Star History 等。但对照"高星开源项目发布前自检清单"，仓库在**可发现性、信任凭证、贡献者友好度**三方面存在客观缺口，直接影响 Star 转化与协作者吸引。

参考资料结论：推广第一步不是发帖，而是让任何点进来的人在 10–15 秒内愿意点 Star。当前首屏被 30 种语言链接占满，价值主张被挤到首屏之外；最显眼的 Star 徽章是坏的；缺失 CONTRIBUTING/CODE_OF_CONDUCT/CHANGELOG/Social Preview/CI 徽章等信任硬通货。

## 2. 目标

通过系统优化项目文档，使仓库达到"可被转发"的标准，提升 Star 转化率与协作者吸引力。**不改变项目功能与既有品牌口径**（保留 README 现有技术栈描述，不越界删除项目方既有内容）。

## 3. 功能点清单与验收标准

### FP-1 修复全部 README 的 Star 徽章仓库路径
- **现状**：30 个 README 的 shields.io stars 图片 URL 写成 `AIGeniusInstitute/deep-think`（带连字符），实际仓库为 `deepthink` → 徽章图裂。
- **改动**：将所有 README 中 `img.shields.io/github/stars/AIGeniusInstitute/deep-think` 修正为 `AIGeniusInstitute/deepthink`。
- **验收标准**：
  - AC1.1：`grep -r 'deep-think' README*.md` 返回 0 行（Star 徽章上下文）。
  - AC1.2：修正后 30 个 README 的 stars 徽章 shields.io URL 与仓库实际路径一致。

### FP-2 新增社区治理文件
- **新增**：
  - `CONTRIBUTING.md`（仓库根，GitHub 自动识别）—— 在 README 既有 Commit Conventions / Development Workflow 基础上扩展：环境搭建、分支命名、提交规范、PR 流程、good-first-issue 指引、代码风格、issue/PR 模板引用。
  - `CODE_OF_CONDUCT.md`（仓库根）—— 基于 Contributor Covenant 2.1。
  - `CHANGELOG.md`（仓库根）—— 聚合 `docs/release-notes/v*.md`，保留指针指向详细发布说明。
  - `.github/FUNDING.yml` —— 接入 GitHub Sponsors 按钮（README 已有捐赠图，统一入口）。
- **验收标准**：
  - AC2.1：四个文件均存在且非空。
  - AC2.2：`CONTRIBUTING.md` 含环境要求、分支规范、提交规范、PR 流程四节。
  - AC2.3：`CODE_OF_CONDUCT.md` 含标准 Contributor Covenant 2.1 文本与联系邮箱。
  - AC2.4：`CHANGELOG.md` 含 v1.0.5 / v1.0.7 / v1.0.10 / v1.1.0 四个版本的条目与 release-notes 指针。
  - AC2.5：`.github/FUNDING.yml` 为合法 YAML。

### FP-3 生成 Social Preview 图
- **现状**：`.github` 无 1280×640 social preview 图，分享到社交平台时卡片无定制预览。
- **改动**：生成 1280×640 PNG，放入 `.github/` 目录；在发布清单中给出 GitHub Settings 设置步骤。
- **验收标准**：
  - AC3.1：`.github/social-preview.png` 存在，尺寸为 1280×640（±容差），PNG 格式。
  - AC3.2：图片在浏览器打开无报错，含项目名 DeepThink 与一句价值主张。

### FP-4 优化 README 首屏并补 CI 徽章
- **现状**：30 种语言链接行巨大，首屏被占满；无 build 状态徽章。
- **改动**：
  - 将 30 种语言链接折叠进 `<details>` 元素，默认收起，让 logo + 标语 + 徽章 + 价值主张回到首屏。
  - 徽章行补充 Release/Build 状态徽章（指向 `release.yml` workflow）。
  - README Contributions 段补一行指向 `CONTRIBUTING.md` 的链接。
- **改动范围**：英文 `README.md` 与中文 `README.zh-CN.md` 两个主入口做首屏结构改动；其余 28 个语言 README 仅做徽章路径修正（FP-1）与折叠同步（保持一致性，机械同步）。
- **验收标准**：
  - AC4.1：`README.md` 首屏（前 30 行）出现 logo + 标语 + 徽章 + "What is DeepThink" 段落。
  - AC4.2：语言链接被 `<details>` 包裹，默认 `closed`。
  - AC4.3：徽章行含 Release/Build 状态徽章，URL 指向 `AIGeniusInstitute/deepthink`。
  - AC4.4：README Contributions 段含 `CONTRIBUTING.md` 链接。

### FP-5 GitHub 仓库设置清单（非文件，交付为文档）
- **交付**：在测试报告中附"GitHub 仓库设置后置清单"，指导维护者在 GitHub Web 端设置：
  - About 描述（≤120 字符，关键词前置）。
  - Topics（用满 20 个）。
  - Social Preview 上传。
  - good-first-issue 标签贴到入门 issue。
  - Description / Website。
- **验收标准**：
  - AC5.1：测试报告含可执行的后置清单，每项有操作路径。

## 4. 非目标（Out of Scope）

- 不改动项目源代码功能逻辑。
- 不删除 README 现有技术栈描述（Claude Code / Agent SDK 等）—— 属项目方既有品牌决策，遵循"外科手术式修改"。
- 不重写 30 种语言 README 正文（仅徽章路径修正 + 首屏折叠同步）。
- 不在本任务内执行 GitHub Web 端设置（About/Topics/Social Preview 上传）—— 交付为清单。

## 5. 假设与权衡

- **假设**：仓库实际名为 `deepthink`（无连字符），依据 `git remote -v` 与 Star History 段已用 `deepthink` 路径。
- **权衡**：品牌口径（不提底层技术）vs 开源透明度。决策：保留现有 README 技术栈表述，仅修客观缺陷——删除会越界且降低开发者信任。

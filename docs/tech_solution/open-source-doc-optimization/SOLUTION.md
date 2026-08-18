# DeepThink 开源文档系统优化 — 技术方案

## 1. 总体策略

纯文档改动，零源代码逻辑变更。所有改动落在 worktree 分支 `docs/open-source-promotion-optimization`。改动分两类：
- **机械批量修正**（FP-1 徽章路径）：脚本化 `sed`，确保 30 个 README 一致。
- **新增文件 + 结构调整**（FP-2/3/4）：手工编写，保持与现有 README 风格一致。

## 2. 文件清单

| 类型 | 路径 | 动作 |
|---|---|---|
| 改 | `README.md`（英文主入口） | 徽章路径修正 + 首屏语言折叠 + CI 徽章 + CONTRIBUTING 链接 |
| 改 | `README.zh-CN.md`（中文主入口） | 同上 |
| 改 | 其余 28 个 `README.*.md` | 徽章路径修正 + 语言行折叠同步 |
| 新增 | `CONTRIBUTING.md` | 仓库根 |
| 新增 | `CODE_OF_CONDUCT.md` | 仓库根 |
| 新增 | `CHANGELOG.md` | 仓库根 |
| 新增 | `.github/FUNDING.yml` | GitHub Sponsors |
| 新增 | `.github/social-preview.png` | 1280×640 |
| 新增 | `docs/prd/open-source-doc-optimization/PRD.md` | 已建 |
| 新增 | `docs/tech_solution/open-source-doc-optimization/SOLUTION.md` | 本文件 |
| 新增 | `docs/task_state/open-source-doc-optimization/STATE.md` | 执行状态 |
| 新增 | `docs/test_report/open-source-doc-optimization/REPORT.md` | 测试报告 |

## 3. 各 FP 实施细节

### FP-1 徽章路径修正
- 命令：对每个 `README.*.md`，将 `img.shields.io/github/stars/AIGeniusInstitute/deep-think` 替换为 `AIGeniusInstitute/deepthink`。
- 仅替换 shields.io stars 上下文中的 `deep-think`，不动文件名、不动 Star History（其本身已用 `deepthink`）。
- 验证：`grep -rn "deep-think" README*.md` 须返回空。

### FP-2 社区文件

#### CONTRIBUTING.md
结构：
1. 欢迎语 + 行为准则引用
2. 开发环境搭建（Node ≥20、`npm install`、`make sync-types`、`make dev`）
3. 分支与提交规范（复用 README 既有：`type: 描述`，中文；分支 `feature/` `fix/` `docs/`）
4. PR 流程（Fork → 分支 → 测试 → PR against main；引用 PR 模板；`make typecheck` / `make test`）
5. good-first-issue 指引
6. Issue 报告（引用 issue 模板）
7. 项目结构（引用 README 表格）

#### CODE_OF_CONDUCT.md
Contributor Covenant 2.1 标准文本 + 联系方式占位（gitcode issue）。

#### CHANGELOG.md
Keep a Changelog 格式。聚合 v1.0.5 / v1.0.7 / v1.0.10 / v1.1.0，每条含一行摘要 + 指向 `docs/release-notes/vX.md` 的详细链接。

#### .github/FUNDING.yml
```yaml
# 示意，实际填维护者赞助渠道
custom: ["https://github.com/AIGeniusInstitute"]  # 占位，待维护者替换为真实赞助链接
```

### FP-3 Social Preview
- 用沙箱浏览器渲染一个 1280×640 的 HTML 横幅，截图为 PNG，存入 `.github/social-preview.png`。
- 内容：深色渐变背景 + DeepThink Logo + 标语 "Self-hosted AI Agent Loop Engineering Platform" + 三条要点。
- 验证尺寸：沙箱内用 `file` 命令或 ImageMagick 若可用确认 1280×640。

### FP-4 首屏优化
- 将 30 种语言链接行（README.md 第 1 行）包进：
  ```
  <details>
  <summary>🌐 Languages</summary>
  ...原链接...
  </details>
  ```
  默认收起。
- 徽章行（第 13–18 行）补 Release 徽章：
  `https://img.shields.io/github/v/release/AIGeniusInstitute/deepthink?style=for-the-badge` 与 workflow build 徽章。
- README Contributions 段首行加：`详见 [CONTRIBUTING.md](CONTRIBUTING.md)。`

### FP-5 GitHub 设置清单
在测试报告中以表格列出 About/Topics/Social Preview/good-first-issue 的 Web 端操作步骤。

## 4. 风险与回滚
- 全部为新增文件与文档文本改动，零运行时风险。
- 回滚：`git revert` 单个合并提交即可。

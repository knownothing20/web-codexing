# 发布流程与隐私检查

## 本地准备

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run release:check
npm.cmd run package:source
# 可选：带新编译托盘 EXE 的候选包
npm.cmd run package:windows
```

两种打包都自动执行完整测试、源码隐私检查、白名单复制、候选目录再次检查，然后生成 ZIP、包内文件 SHA256 清单和 ZIP 的 `.sha256`。没有跳过检查的参数；任一步失败都不生成新的 ZIP。`dist/` 的候选包留在本机，不自动上传。

Windows 包包含刚从候选源码编译的启动器，**仍需安装 Node.js 24+，解压后运行 `npm ci --omit=dev --ignore-scripts`**。没有捆绑本机 `node_modules`、Node 运行时或任何账号数据。不要只发一个 EXE 并称其可独立运行。

编译在独立 `.local/release-*` 候选目录进行，不覆盖正在运行的旧 EXE。隐私扫描不把任意 EXE 当作可检查文本；只允许打包器刚编译并记录 SHA256 的启动器进入 Windows 候选包。

## 自动检查什么

- 根目录发布白名单、禁止链接文件、未审阅二进制、异常大文件。
- 运行数据、数据库、日志、凭据文件，以及误加入 Git 索引的 ignore 文件。
- 工作区和 Git 索引中的已知密钥格式、JWT、长字面量凭据、认证 URL、会话 Cookie。
- 个人邮箱、用户目录、个人项目绝对路径、实际内网 / tailnet IPv4。
- 预览 PNG 的文本、EXIF 等元数据以及图片尾部附加内容。
- 输出只给出文件、行号、规则，不回显命中的秘密值。

源码中的变量名、环境变量名、占位符和 `example.com` 邮箱可用，不要把真实值粘进文档。遇到误报应修正示例、规则或新增精确测试，不能靠整目录排除或跳过检查发布。

扫描范围是当前候选文件及 Git 索引，**不是 Git 所有历史，也不能读懂图片里的私人内容或识别所有形式的秘密**。预览图只能用演示数据，公开前还需人工看图。曾经提交过秘密时，即使当前检查通过，也必须先撤销秘密并处理历史，再考虑公开。

## GitHub 检查和正式发布

`.github/workflows/check.yml` 在 push、PR 和手动触发时执行测试与隐私检查。`package.yml` 只在手动触发时生成通过检查的 Windows 候选 Artifact，不创建 GitHub Release、不推送标签。

建议在 GitHub 设置分支保护 / ruleset，要求 `Tests and publication privacy / check` 通过。管理员仍可手动上传任意文件；脚本不能阻止绕开流程的人。正式发布只使用候选工作流产物或本地打包器产物。

首次公开上传流程：审阅候选文件清单 → 初始化 / 关联目标仓库 → 扫描暂存区 → 提交推送 → 等待 CI → 检查 GitHub README 的图片和链接。不要拖整个项目文件夹上传网页。

发布新版本时：更新版本 → 使用打包命令生成候选包 → 等待对应提交的 CI → 人工检查预览与 ZIP → 选择版本创建 Release，上传 ZIP 和 `.sha256`。源码上传和版本 Release 是不同操作，不会由本地打包命令自动执行。

## README 预览图

公开图片放 `docs/previews/`，README 使用相对路径，例如：

```markdown
![手机对话演示](docs/previews/mobile.png)
```

README 包含主视觉 `hero.png`、带功能说明的手机预览 `features.png` 和连接方式 `connection.png`。排版源文件在 `docs/visuals/overview.html`，运行 `node scripts/preview-docs.mjs` 可本机预览三张图的排版；截图后保存为无隐私元数据的 PNG。

手机原图由 `npm run preview:demo` 的隔离演示服务配合浏览器截图生成，不接触真实 Codex。更新 UI 后重新截图；先人工确认没有真实聊天、配对码、电脑名、个人路径和账号，再运行隐私检查。不要把本机验收截图直接复制进来。

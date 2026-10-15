# 目录与发布边界

```text
web-codexing/
├─ src/                  Windows Codex 桥接、历史、鉴权、图片与网络检查
├─ public/               手机 / 电脑浏览器共用的界面
├─ desktop/              Windows 托盘启动器 C# 源码
├─ integrations/         默认关闭的实验配置模板，不放真实授权
├─ test/                 单元、协议、HTTP 与隐私检查测试
├─ scripts/              发布白名单、隐私扫描、打包与演示预览
├─ docs/
│  ├─ previews/          仅放演示数据生成的公开 PNG
│  ├─ ABOUT.md           GitHub About 可复制文案
│  ├─ STRUCTURE.md       本文
│  ├─ PUBLISHING.md      发布步骤与检查边界
│  └─ TAILSCALE.md       自行配置远程访问
├─ .github/workflows/    自动检查、手动生成已检查候选包
├─ README.md             用户介绍、预览、安装与功能边界
├─ LICENSE               MIT
├─ SECURITY.md           运行安全与隐私反馈
├─ CONTRIBUTING.md       最小开发与提交约定
├─ package*.json         运行依赖、锁定版本与命令
├─ build.ps1             编译托盘启动器
└─ start.cmd             启动入口
```

| 内容 | GitHub 源码 | 发布 ZIP | 只留本机 |
| --- | --- | --- | --- |
| 上面列出的源码、文档、测试、工作流 | 是 | 是 | |
| `docs/previews/*.png` 的公开演示图 | 是 | 是 | |
| 从候选包源码重新编译的 `RemoteCoding.exe` | 否 | Windows 候选包包含 | |
| `RELEASE-MANIFEST.json`、ZIP SHA256 | 否，打包时生成 | 是 | |
| `.local/`、配对码、设备哈希、运行设置、日志 | 否 | 否 | 是 |
| Codex 数据库、JSONL、真实会话和附件 | 否 | 否 | 是 |
| `.env*`、证书、密钥、真实授权配置 | 否 | 否 | 是 |
| `node_modules/`、旧 EXE、`dist/`、临时测试截图 | 否 | 否 | 是 |

实际边界以 `scripts/public-files.mjs` 的白名单和 `scripts/privacy-check.mjs` 的检查为准。新增顶层目录必须先决定是否公开，未登记目录会阻断发布。`.gitignore` 只负责避免误加入 Git；隐私脚本还检查 Git 索引，已被追踪的私密文件不会因为后来加入 ignore 就自动安全。

不移动现有 `.local/`，不复制桌面 Codex 的账号目录。开源项目首次运行会生成自己的本地状态，默认要求手机配对。

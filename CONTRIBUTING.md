# 参与开发

开发环境：Windows、Node.js 24+；真实桌面联调还需要 Windows Codex。先执行 `npm ci --ignore-scripts`，再执行 `npm test`。

- Web 界面位于 `public/`，桥接位于 `src/`，托盘源码位于 `desktop/`。
- 通过 `npm start` 本机运行；`build.ps1` 编译托盘。修改后正常退出旧托盘再启动，不强制结束 Codex。
- 测试使用临时数据库和独立协议服务，不调用真实模型、不提交付费任务。`npm run preview:demo` 是独立演示网页，不连接真实会话。
- 提交前运行 `npm run release:check`，新增发布路径需更新 `scripts/public-files.mjs`。
- 不提交 `.local/`、日志、数据库、真实截图、个人路径、Token 或账号授权；Issue 和 PR 同样需要去除这些内容。
- 改网络或鉴权时保留 Host / Origin / CSRF 和配对边界；改审批或发送时保留去重及结果不明不自动重发的行为。

PR 请说明用户可见变化、测试方法与未验证边界。实验适配器默认关闭，不以模拟测试声称第三方真实接通。

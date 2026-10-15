# 自行配置 Tailscale 外网访问

局域网使用无需 Tailscale。离开同一 Wi-Fi 后，可以在电脑和手机自行安装 Tailscale，将两台设备加入自己的 tailnet，再用私有隧道访问电脑上的网页。电脑必须保持开机，Codex 和桥接服务需要运行。

**维护者已在自己的设备上验证 Tailscale 访问可用（2026-10-15）。** 下面提供本版可选的 IPv4 直连配置；其他设备仍需按自己的 tailnet 权限、地址、端口和防火墙设置连接。

本项目不代办登录、保存 Tailscale 授权或创建公网服务。设备加入方式以 [Tailscale 官方文档](https://tailscale.com/docs/install) 为准。

## 本版支持：直接访问 Tailscale IPv4

1. 在电脑安装并连接 Tailscale，手机也连接同一个允许访问电脑的 tailnet。
2. 正常退出 Web Codexing / Remote Coding 托盘程序。
3. 在项目目录的 PowerShell 中运行：

   ```powershell
   $env:REMOTE_CODING_TAILSCALE = '1'
   .\start.cmd
   ```

4. 用 `tailscale ip -4` 查询电脑的 Tailscale IPv4。托盘面板也会列出已发现的受支持 IPv4 地址。以面板实际端口为准，在手机打开 `http://<电脑的Tailscale IPv4>:3210/`，输入电脑显示的配对码。
5. 保持电脑控制面板的“局域网免配对”关闭。它控制所有允许的网络来源；一旦打开，具有网络访问权限的 tailnet 设备也能操作会话。

开关默认关闭，环境变量仅对这次启动及其子进程生效。再次启动时仍需提供；若旧托盘还在运行，重新启动只会打开旧面板，不会更新环境变量。首次启用后需正常退出并重启。

此开关仅允许 [Tailscale IPv4 使用的 CGNAT 地址段](https://tailscale.com/docs/concepts/tailscale-ip-addresses)，并继续检查电脑实际网卡地址、Host、同源、配对和 CSRF。CGNAT 地址本身不证明 Tailscale 身份；访问范围还应由 Tailscale 的访问策略和 Windows 防火墙限制。程序不会自动修改这些设置。

## 当前不支持的配置

- 此处只说明 IPv4 直连；本版没有适配 MagicDNS Host、Tailscale IPv6 或 Serve 的 HTTPS 反向代理来源。
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) 可以在 tailnet 内代理服务，但不能直接套用到本版的 Host / Origin 检查；不要通过关闭这些检查来绕过。
- 不使用 Funnel 或路由器公网端口映射公开控制页面。

网页本身仍使用 HTTP；Tailscale 私有隧道负责设备间传输加密。局域网直连的 HTTP 不具备这个隧道保护。地址开关有隔离测试，Tailscale 访问由维护者在自己的设备上验证；本项目不会替使用者完成 Tailscale 配置。

# 远程控制软件

主控机**零安装**（只用浏览器）远程操作被控机：被控机运行 Agent 采集屏幕并注入键鼠，
画面走 **H.264(NVENC) 经 WebSocket 传给浏览器 WebCodecs 解码**，跨网出入口用
**国内云服务器 + frp 反向代理**，并用 **Caddy 自动签发 HTTPS 证书**（浏览器安全上下文所需）。

## 架构

```
主控机 浏览器  --https(443)-->  上海/国内云服务器(Caddy 终结 TLS)
                                   └── frp(frps)  <--出站长连接-- frpc(被控机)
                                                                  └── Agent(127.0.0.1:8443)
媒体：H.264 over WebSocket（同一条 HTTPS 隧道内），浏览器 WebCodecs 硬/软解
输入：独立 /ws-input 通道（避免视频大帧队头阻塞）；WebRTC 可用时走 DataChannel
```

- 被控机**主动外连**云服务器，无需公网 IP、无需在路由器开端口。
- 域名 `remote.你的域名` 用 **Cloudflare DNS（灰云/仅 DNS）** 解析到云服务器公网 IP。
- Caddy 自动申请 Let's Encrypt 证书，主控机访问 `https://remote.你的域名` 即可。

## 环境要求

| 角色 | 要求 |
| --- | --- |
| 被控机 | Windows 10/11，**管理员权限**，NVIDIA 显卡（NVENC 硬编）；开启自动登录可实现无人值守 |
| 主控机 | Windows，自带 Edge/Chrome，**无需安装任何程序** |
| 云服务器 | 国内云主机（腾讯云/阿里云），Ubuntu 22.04，公网 IP，安全组放行 `22/80/443/7000` |
| DNS | 一个托管在 Cloudflare 的域名 |

---

## 一、被控机部署

```powershell
# 1) 首次：创建虚拟环境并安装依赖（约几分钟）
powershell -ExecutionPolicy Bypass -File scripts\start_agent.ps1

# 2) 设置访问密码（默认 admin，务必修改）
.venv\Scripts\python.exe agent\main.py --set-password 你的强密码
```

> 依赖安装必须带 `--only-binary=:all:`（脚本已处理），否则 `av` 会尝试源码编译而失败。
> 需要向以管理员运行的窗口注入键鼠时，请以管理员身份启动。

## 二、云服务器部署（一次性）

1. **DNS**：Cloudflare 添加 `A` 记录 `remote` → 云服务器公网 IP，**关闭小黄云（仅 DNS）**。
2. **安全组**：放行入站 TCP `22 / 80 / 443 / 7000`。
3. **在服务器上执行** `vps/install.sh`（装 frps + Caddy 并设 systemd 自启）：
   ```bash
   bash install.sh remote.你的域名 <FRP令牌>
   ```
   - `frps` 监听 `7000`，把远程端口 `8443` 只绑定到 `127.0.0.1`；
   - `Caddy` 监听 `443`，自动申请证书并反代到 `127.0.0.1:8443`；
   - 两者都已 `systemctl enable`，开机自启，**无需再管**。

## 三、被控机连接服务器

```powershell
# 首次会自动下载 frpc，然后连接并把本地 8443 穿透到服务器
powershell -ExecutionPolicy Bypass -File scripts\start_frpc.ps1 -ServerAddr <云服务器IP> -Token <FRP令牌>
```

## 四、日常启动 / 开机自启

被控机每次开机（登录）后只需启动 **Agent + frpc** 两件事：

```powershell
# 手动一键启动（都后台隐藏运行，日志在 logs\）
powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1
```

**开机自启**（管理员运行一次，注册计划任务，登录后自动拉起 Agent+frpc）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1
# 立即测试： Start-ScheduledTask -TaskName RemoteControlAgent
# 卸载：     Unregister-ScheduledTask -TaskName RemoteControlAgent -Confirm:$false
```

> 计划任务在「用户登录后」触发（Agent 必须在桌面会话中才能截屏/注入）。
> 无人值守请开启自动登录：`netplwiz` 里取消“必须输入用户名和密码”。

## 五、主控机使用

浏览器打开 **`https://remote.你的域名`** → 输入密码 → 连接后建议点「全屏锁定」（拦截 Ctrl+W 等）。

工具栏说明：

| 控件 | 说明 |
| --- | --- |
| 状态 / stats / diag | 连接状态、帧率/码率、诊断（模式、帧龄、RTT、解码方式等） |
| 画质档位 | 流畅 1024×576 / 均衡 1440×810 / 高清 1920×1080（即时切换） |
| 本地光标 | 勾选=本地即时光标（跟手，但看不到被控机真实光标形状）；不勾=真实光标 |
| 兼容模式 | 在 H.264 与 JPEG 之间切换 |
| 全屏锁定 | 全屏并 `keyboard.lock()`，把键盘交给被控机 |

---

## 目录结构

```
agent/           被控机 Agent
  main.py        入口：参数 / TLS / 启动服务
  server.py      本地 Web + 登录 + 信令 + H.264/JPEG 兜底 + 自适应码率
  capture.py     DXGI 截屏(dxcam) + 鼠标光标叠加（mss 兜底）
  encoder.py     NVENC：WebRTC 轨编码器 + WS 用 Annex-B 编码器
  stream.py      WebRTC 视频轨
  injector.py    SendInput 键鼠注入
  auth.py        令牌 / 登录限速
  config.py      配置读写 / 密码哈希
  config.json    运行配置（含密钥，勿外传，已 gitignore）
web/             主控端浏览器界面（app.js / index.html / style.css）
scripts/         start_all / install_autostart / start_frpc / start_agent
vps/             服务器端 install.sh（frps+Caddy）、setup_ssl.sh（DNS-01 证书，备用）
frp/             frpc.toml（含令牌）
tools/           frpc.exe 等便携程序
logs/            运行日志（自动生成）
```

## 配置项 `agent/config.json`

| 字段 | 说明 |
| --- | --- |
| `host` / `port` | 本地监听（默认 `127.0.0.1:8443`，frpc 连接它） |
| `password_hash` | PBKDF2 密码哈希（用 `--set-password` 修改） |
| `fps` | 采集帧率（默认 60；H.264 输出上限 30） |
| `bitrate` | WebRTC 目标码率 |
| `monitor` | 采集的显示器序号（从 0 开始） |
| `session_ttl` | 登录令牌有效期（秒） |
| `ice_servers` | WebRTC ICE 服务器（STUN/TURN） |
| `tls_cert` / `tls_key` | 可选，Agent 直接对外提供 HTTPS 时使用 |

## 常见问题

**1. 装依赖时 `av` 编译失败**
必须加 `--only-binary=:all:`（脚本已处理）。

**2. 画面卡顿 / CPU 占用高**
- 日志确认出现 `NvencH264Encoder active`；若出现 `NVENC 失败，改用 libx264`，说明显卡不支持，降低 `fps`/`bitrate` 或改用兼容模式 JPEG。
- **主控机无独显**时 1080p 软解吃力，请在画质档选「流畅/均衡」。

**3. 操作“不跟手”**
跨网中转 + 编解码存在固有延迟，属正常。勾选「本地光标」可获得即时光标反馈；`diag` 里
`RTT` 反映网络往返，`帧龄` 反映画面新旧。

**4. 页面打不开 / 报 Cloudflare 525 / 证书错误**
多半是**旧地址的 DNS 缓存**（早期用过 Cloudflare 隧道）。权威 DNS 已是直连服务器，
等 TTL 过期，或在主控机 `ipconfig /flushdns`、改公共 DNS，或 hosts 写死服务器 IP。

**5. WebRTC 连不上**
内网/对称 NAT 下 P2P 打洞常失败，会自动切到「兼容模式(硬解)」（H.264 over WS），功能不受影响。
要更低延迟可部署 TURN 中转。

**6. 看不到 UAC 弹窗 / 按不了 Ctrl+Alt+Del**
- Ctrl+Alt+Del 属安全桌面，任何用户态软件都无法下发。
- UAC 弹窗需**以管理员身份运行 Agent** 才可见可控。

## 安全说明

- 密码以 PBKDF2-SHA256 加盐存储，登录失败指数退避；会话令牌 HMAC 签名、带有效期。
- 对外只暴露云服务器的 443（Caddy 终结 TLS）；Agent 与 frps 的 8443 均只绑定本地回环。
- `agent/config.json` 与 `frp/frpc.toml` 含密钥/令牌，均已 gitignore，请勿外发。

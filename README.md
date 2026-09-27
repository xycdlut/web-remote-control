# 远程控制软件

主控机**零安装**（只用浏览器）远程操作被控机：被控机运行 Agent 采集屏幕并注入键鼠。
媒体默认走 **WebRTC（H.264 / NVIDIA NVENC）**：同网或可打洞时 **P2P 直连**，失败自动经 **TURN 中继**，
仍不行才退回 **H.264 over WebSocket + 浏览器 WebCodecs 硬解**。跨网出入口用
**国内云服务器 + frp 反向代理**，并用 **Caddy 自动签发 HTTPS 证书**（浏览器安全上下文所需）。

> 当前版本 **v84**（主控端工具栏左上角显示版本号）。

## 架构

```
主控机 浏览器  --https(443)-->  国内云服务器(Caddy 终结 TLS)
                                   ├── frp(frps)  <--出站长连接-- frpc(被控机)
                                   │                              └── Agent(127.0.0.1:8443)
                                   └── coturn(TURN 3478)  <-- 中继媒体（P2P 打洞失败时）
媒体：优先 WebRTC（P2P 直连 / TURN 中继，H.264/NVENC）；不可用时退回 H.264 over WebSocket + WebCodecs
输入：WebRTC 时走 DataChannel；WS 模式走独立 /ws-input（避免视频大帧队头阻塞）
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
C:\path\to\python-env\python.exe agent\main.py --set-password 你的强密码
```

> 运行环境建在 **D 盘 Anaconda** 下：`C:\path\to\python-env`（conda 环境 `remote_control`，Python 3.9）。
> 依赖安装必须带 `--only-binary=:all:`（脚本已处理），否则 `av` 会尝试源码编译而失败。
> 需要向以管理员运行的窗口注入键鼠时，请以管理员身份启动。

## 二、云服务器部署（一次性）

1. **DNS**：Cloudflare 添加 `A` 记录 `remote` → 云服务器公网 IP，**关闭小黄云（仅 DNS）**。
2. **安全组**：放行入站 TCP `22 / 80 / 443 / 7000`；若启用 TURN，再加 `UDP+TCP 3478`、`TCP 5349`、`UDP 49160-49200`。
3. **在服务器上执行** `vps/install.sh`（装 frps + Caddy 并设 systemd 自启）：
   ```bash
   bash install.sh remote.你的域名 <FRP令牌>
   ```
   - `frps` 监听 `7000`，把远程端口 `8443` 只绑定到 `127.0.0.1`；
   - `Caddy` 监听 `443`，自动申请证书并反代到 `127.0.0.1:8443`；
   - 两者都已 `systemctl enable`，开机自启，**无需再管**。
4. **（强烈建议）部署 TURN 中继** `vps/install_turn.sh`，让"不同局域网、P2P 打洞失败"时也能走 **WebRTC 低延迟管线**（而不是退回 ~135ms 的 WebCodecs 兼容模式）：
   ```bash
   bash install_turn.sh remote.你的域名 remote 你的TURN强密码
   ```
   - 脚本会安装 coturn、写配置、`systemctl enable --now coturn`，并**打印一段 `ice_servers`**；
   - 把这段合并进 `agent/config.json` 的 `ice_servers`（或直接改脚本里的默认账号）；
   - 别忘了安全组放行 TURN 端口与中继端口段；
   - 自检：`turnutils_uclient -v -u remote -w '你的TURN强密码' -p 3478 remote.你的域名`。

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
| 状态 / stats / diag | 连接状态、帧率/码率、诊断（模式、帧龄、RTT、键事件、解码方式等） |
| 画质档位 | **仅硬解码模式**：流畅 1024×576 / 均衡 1440×810 / 高清 1920×1080（即时切换） |
| 码率 | **仅 WebRTC（直连/中继）**：2 / 4 / 8 / 16 Mbps（默认 8M，会记忆）。中继受服务器带宽限制，**建议 2M**，详见「性能与限制」 |
| 模式 | 直连（WebRTC）/ 硬解码（H.264 over WebSocket + WebCodecs）；Ctrl+Alt+M 或命令模式 `M` 循环切换 |
| 强制中继 | 仅直连模式：强制 WebRTC 走 TURN（打洞失败时也会自动转） |
| 全屏锁定 | 全屏并锁定键盘；**全屏时** Win / Alt+Tab / Ctrl+Shift+Esc 等系统快捷键转发给被控机，非全屏交回本机 |

> 主控端操作这些控件有两种方式：
> 1. **命令模式**：先按 <code>`</code>（数字 1 左边的键），再按 `1/2/3` 画质、`M` 模式、`F` 全屏、`R` 强制中继、`Q` 断开；
> 2. 或用组合键 `Ctrl+Alt+1/2/3/M/F/R/Q`。
> 这些都不发给被控机。注意：需先**点击远控页面**使其获得键盘焦点（多显示器下鼠标移过去不会自动切换键盘焦点）。
>
> 转发快捷键：按 **Ctrl+D** 让被控机显示桌面（等价于在被控机按 Win+D）。
>
> 模式与中继：工具栏「模式」可选 直连 / 硬解码；「码率」下拉可选 2/4/8/16 Mbps（**直连与中继都生效**）。
> 勾选「强制中继」（或按 `Ctrl+Alt+R`）后 WebRTC 强制走 TURN——P2P 打洞失败也能保持低延迟（需先按第二节第 4 步在服务器部署 coturn 并在 `ice_servers` 填好账号）。不勾选时先试 P2P，失败会自动转 TURN，仍失败才退硬解码兼容模式。
>
> 快捷键注意：本地快捷键要求 **先按住 Ctrl+Alt 再按功能键**；长按产生的重复事件、以及“先按功能键再补 Ctrl+Alt”都不会误触发（已修复）。
>
> 光标：画面区内隐藏系统箭头、显示被控机真实光标；工具栏等页面控件使用**系统原生光标**，保证在多显示器/缩放下都能精确点击。

---

## 性能与限制（实测，v84）

| 项目 | 直连（P2P） | 中继（TURN） | 硬解码（WS） |
| --- | --- | --- | --- |
| 真实端到端延迟* | ≈120 ms | ≈167 ms | ≈269 ms |
| 可选码率 | 2/4/8/16 Mbps | 2/4/8/16 Mbps（**建议 2M**） | 由画质档决定 |
| 主要瓶颈 | 双方 P2P 带宽 | **云服务器转发带宽** | 服务端编码 + WS |

\* 时钟法实测：被控桌面显示毫秒时钟，主控端从收到的画面里解码出采集时刻，二者差值（含采集/编码/网络/解码/显示全链路）。

- **中继带宽是硬瓶颈**：快速滚动/翻页等高运动场景下，实测 **2 Mbps 稳定**；**4 Mbps 开始掉帧**；**8/16 Mbps 拥塞到降级兼容模式甚至断连**。中继请用 2 Mbps。
- 码率下拉对直连/中继都生效，且既是目标也是 REMB 上限（只能往下自适应，不能超过所选值）。
- 延迟**不随「模式切换次数增多」累积**；单次会话内直连/硬解码基本平稳，中继有轻微上升（约 +30ms/90s，抖动更大）。

## 目录结构

```
agent/           被控机 Agent
  main.py        入口：参数 / TLS / 启动服务
  server.py      本地 Web + 登录 + 信令 + WebRTC + H.264 硬解码兜底 + 自适应码率
  capture.py     DXGI 截屏(dxcam) + 鼠标光标叠加（mss 兜底）
  encoder.py     NVENC：WebRTC 轨编码器（含码率上限/GOP）+ WS 用 Annex-B 编码器
  stream.py      WebRTC 视频轨
  injector.py    SendInput 键鼠注入
  auth.py        令牌 / 登录限速
  config.py      配置读写 / 密码哈希
  config.json    运行配置（含密钥，勿外传，已 gitignore）
web/             主控端浏览器界面（app.js / index.html / style.css / h264worker.js）
scripts/         start_all / install_autostart / start_frpc / start_agent / restart_agent
重启Agent.cmd     双击一键重启 Agent（自动 UAC 提权）
vps/             install.sh（frps+Caddy）、install_turn.sh（coturn 中继）、setup_ssl.sh（备用）
frp/             frpc.toml（含令牌，已 gitignore）
tools/           frpc.exe 等便携程序（已 gitignore）
logs/            运行日志（自动生成）
```

## 配置项 `agent/config.json`

| 字段 | 说明 |
| --- | --- |
| `host` / `port` | 本地监听（默认 `127.0.0.1:8443`，frpc 连接它） |
| `password_hash` | PBKDF2 密码哈希（用 `--set-password` 修改） |
| `fps` | 采集帧率（默认 60；WebRTC 直接使用，硬解码 WS 输出上限 30） |
| `bitrate` | WebRTC 初始/默认码率（连接后由工具栏「码率」下拉覆盖，直连/中继均生效） |
| `monitor` | 采集的显示器序号（从 0 开始） |
| `session_ttl` | 登录令牌有效期（秒） |
| `ice_servers` | WebRTC ICE 服务器（STUN/TURN） |
| `tls_cert` / `tls_key` | 可选，Agent 直接对外提供 HTTPS 时使用 |

## 常见问题

**1. 装依赖时 `av` 编译失败**
必须加 `--only-binary=:all:`（脚本已处理）。

**2. 画面卡顿 / CPU 占用高**
- 日志确认出现 `NvencH264Encoder active`；若出现 `NVENC 失败，改用 libx264`，说明显卡不支持，降低 `fps`/`bitrate` 或改用硬解码（H.264）兼容模式。
- **主控机无独显**时 1080p 软解吃力，请在画质档选「流畅/均衡」。

**3. 操作“不跟手”**
跨网中转 + 编解码存在固有延迟，属正常。`diag` 里 `RTT` 反映网络往返，`帧龄` 反映画面新旧。

**4. 页面打不开 / 报 Cloudflare 525 / 证书错误**
多半是**旧地址的 DNS 缓存**（早期用过 Cloudflare 隧道）。权威 DNS 已是直连服务器，
等 TTL 过期，或在主控机 `ipconfig /flushdns`、改公共 DNS，或 hosts 写死服务器 IP。

**5. WebRTC 连不上**
内网/对称 NAT 下 P2P 打洞常失败，会自动切到「兼容模式(硬解)」（H.264 over WS），功能不受影响。
要更低延迟可部署 TURN 中转。

**6. 看不到 UAC 弹窗 / 按不了 Ctrl+Alt+Del**
- Ctrl+Alt+Del 属安全桌面，任何用户态软件都无法下发。
- UAC 弹窗需**以管理员身份运行 Agent** 才可见可控。

**7. 中继模式卡顿 / 降级 / 断连**
TURN 中继的媒体全部经云服务器转发，带宽有限（实测约 **2 Mbps** 量级）。中继码率设高（尤其 4/8/16M）在快速滚动、翻页等高运动场景会先掉帧、再降级到硬解码兼容模式、甚至断连。**中继请用 2 Mbps**；要高画质请用直连（8/16M）。

## 安全说明

- 密码以 PBKDF2-SHA256 加盐存储，登录失败指数退避；会话令牌 HMAC 签名、带有效期。
- 对外只暴露云服务器的 443（Caddy 终结 TLS）；Agent 与 frps 的 8443 均只绑定本地回环。
- `agent/config.json` 与 `frp/frpc.toml` 含密钥/令牌，均已 gitignore，请勿外发。

## 更新日志

- **v84**：工具栏新增「码率」下拉（2/4/8/16 Mbps），**直连与中继都生效**；修复本地快捷键在“先按功能键再补 Ctrl+Alt / 长按重复 / 同机注入回声”下误触发全屏；中继稳定性改进（编码码率上限、GOP=`fps×4`、REMB 抖动不再频繁重建 NVENC、中继改用浏览器自适应抖动缓冲、无画面看门狗放宽）；新增 `scripts/restart_agent.ps1` 与根目录 `重启Agent.cmd` 一键重启；清理 JPEG 兜底与无用代码。
- **v80 及以前**：WebRTC 直连/中继 + H.264 over WS 硬解码双模式、coturn 中继、frp+Caddy 部署脚本、WebCodecs Worker 解码。

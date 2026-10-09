# 远程控制软件（被控机 Agent + 主控端浏览器）

主控机**零安装**（只用浏览器）即可远程操作被控机：被控机运行 Agent 采集屏幕并注入键鼠。  
媒体优先走 **WebRTC（H.264 / NVIDIA NVENC）**——同网或可打洞时 **P2P 直连**，失败自动经 **TURN 中继**，  
仍不行才退回 **H.264 over WebSocket + 浏览器 WebCodecs 硬解**。被控机主动外连云服务器，  
无需公网 IP、无需在路由器开端口；主控端只需打开一个 HTTPS 网址。

> 只要你**有一台带公网 IP 的云服务器**和**一个能解析到它的域名**，按下面步骤即可从零搭好。

---

## 架构

```
主控机 浏览器  --https(443)-->  云服务器(Caddy 终结 TLS)
                                   ├── frp(frps)  <--出站长连接-- frpc(被控机)
                                   │                              └── Agent(127.0.0.1:8443)
                                   └── coturn(TURN 3478)  <-- 中继媒体（P2P 打洞失败时）
媒体：优先 WebRTC（P2P 直连 / TURN 中继，H.264/NVENC）；不可用时退回 H.264 over WebSocket + WebCodecs
输入：WebRTC 时走 DataChannel；WS 模式走独立 /api/signal-in（避免视频大帧队头阻塞）
```

- 被控机**主动外连**云服务器（frpc），无需公网 IP。
- 域名用 **Cloudflare DNS（灰云/仅 DNS）** 解析到云服务器公网 IP；**Caddy 自动申请 Let's Encrypt 证书**。

## 环境要求

| 角色   | 要求                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 被控机  | Windows 10/11，**管理员权限**，NVIDIA 显卡（NVENC 硬编）；开启自动登录可实现无人值守                                                                                            |
| 主控机  | 任意带 Edge/Chrome 的机器，**无需安装任何程序**                                                                                                                     |
| 云服务器 | 国内云主机（腾讯云/阿里云等），Ubuntu 22.04，**公网 IP**（若是「私网 IP + 公网 EIP」也可，脚本会自动处理），安全组放行 `22/80/443/7000`（启用 TURN 时另加 `UDP+TCP 3478`、`TCP 5349`、`UDP 49160-49200`） |
| DNS  | 一个托管在 Cloudflare 的域名（添加一条 `A` 记录指向服务器公网 IP，**关闭小黄云/仅 DNS**）                                                                                          |

---

## 一、云服务器部署（一次性）

在服务器上（Ubuntu/Debian, amd64）。先把本仓库的 **`vps/` 目录上传到服务器**（或 `git clone` 本项目），然后：

```bash
# 1) 安装 frps（中转）+ Caddy（自动 HTTPS，反代到本机 8443）
bash vps/install.sh <你的域名> <FRP令牌>
#   例： bash install.sh remote.example.com MyFrpToken123

# 2)（强烈建议）安装 coturn（TURN 中继），让 P2P 打洞失败时也能走 WebRTC 低延迟管线
bash vps/install_turn.sh <你的域名> <TURN用户名> <TURN密码> [公网IP]
#   例： bash install_turn.sh remote.example.com turnuser TurnPass123
```

- `vps/install.sh`：`frps` 监听 `7000`、远程端口 `8443` 只绑 `127.0.0.1`；`Caddy` 监听 `443` 自动签证书并反代。
- `vps/install_turn.sh`：装 `coturn` 并打印一段 `ice_servers` JSON。请把这段填入 **被控机** `agent/config.json` 的 `ice_servers`（见第二节第 3 步）。
- 安全组务必放行：`22/80/443/7000`，以及 TURN 的 `UDP+TCP 3478`、`TCP 5349`、`UDP 49160-49200`。

## 二、被控机部署

```powershell
# 1) 首次一键启动：会自动创建 .venv、装依赖、下载 frpc，然后后台启动 Agent + frpc
#    （用管理员 PowerShell 运行；<服务器IP> 填云服务器公网 IP，<FRP令牌> 与第一节一致）
powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1 -ServerAddr <服务器公网IP> -Token <FRP令牌>

# 2) 设置访问密码（默认 admin，务必修改）
.venv\Scripts\python.exe agent\main.py --set-password <你的访问密码>
#   注：若你用别的 Python（见下），把 .venv\Scripts\python.exe 换成对应解释器

# 3) 若要启用 TURN 中继：编辑 agent\config.json，把第一节 install_turn.sh 打印的 ice_servers 合并进去
#    然后重启 Agent：双击 重启Agent.cmd 或运行 scripts\restart_agent.ps1
```

**关于 Python 环境**（脚本已尽量通用，无需手改路径）：

- 解释器解析优先级：`-PyExe <python.exe>` 参数 → 环境变量 `RC_PY` → 项目内 `.venv` → `PATH` 上的 `python`。
- 若都没有，`start_all.ps1` 会用 `python -m venv` 在项目内创建 `.venv` 并安装 `requirements.txt`。
- 你也可以指定任意已有环境：`scripts\start_all.ps1 ... -PyExe "C:\path\to\python.exe"`，或设置 `$env:RC_PY`。

## 三、日常启动 / 开机自启

被控机每次开机（登录）后需启动 **Agent + frpc**：

```powershell
# 手动一键启动（后台隐藏运行，日志在 logs\）
powershell -ExecutionPolicy Bypass -File scripts\start_all.ps1 -ServerAddr <服务器IP> -Token <FRP令牌>
```

**开机自启**（以**管理员**运行一次，注册计划任务，登录后自动拉起）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1 -ServerAddr <服务器IP> -Token <FRP令牌>
# 立即测试： Start-ScheduledTask -TaskName RemoteControlAgent
# 卸载：     Unregister-ScheduledTask -TaskName RemoteControlAgent -Confirm:$false
```

> 计划任务在「用户登录后」触发（Agent 必须在桌面会话中才能截屏/注入）。  
> 无人值守请开启自动登录：`netplwiz` 里取消“必须输入用户名和密码”。

**重启 Agent**（改了 `agent\` 下代码后让改动生效）：

```powershell
# 双击 重启Agent.cmd，或：
powershell -ExecutionPolicy Bypass -File scripts\restart_agent.ps1
```

## 四、主控机使用

浏览器打开 **`https://<你的域名>`** → 输入访问密码 → 连接后建议点「全屏锁定」。

工具栏说明：

| 控件                | 说明                                                           |
| ----------------- | ------------------------------------------------------------ |
| 状态 / stats / diag | 连接状态、帧率/码率、诊断（模式、帧龄、RTT、解码方式等）                               |
| 模式                | 直连（WebRTC）/ 硬解码（H.264 over WebSocket + WebCodecs）；默认**中继优先** |
| 强制中继              | 默认勾选：WebRTC 走 TURN 中继；取消则先试 P2P 直连，失败自动转 TURN                |
| 码率                | WebRTC（直连/中继）码率：2/4/8/16 Mbps（会记忆）。**中继建议 2–4M**             |
| 画质档位              | **仅硬解码模式**：流畅 1024×576 / 均衡 1440×810 / 高清 1920×1080          |
| 全屏锁定              | 全屏并锁定键盘；全屏时 Win / Alt+Tab 等系统快捷键转发给被控机                       |

**快捷键**：

1. **命令模式**：先按 `` ` ``（数字 1 左边的键），再按 `1/2/3` 画质、`M` 模式、`F` 全屏、`R` 中继、`Q` 断开；
2. 或组合键 `Ctrl+Alt+1/2/3/M/F/R/Q`（需先**点击远控页面**获取键盘焦点；要求 **Ctrl+Alt 先按住再按功能键**）。
3. 转发快捷键：`Ctrl+D` → 被控机显示桌面（等价 Win+D）。

---

## 性能与限制（实测参考）

| 项目         | 直连（P2P）       | 中继（TURN）              | 硬解码（WS）    |
| ---------- | ------------- | --------------------- | ---------- |
| 端到端延迟（时钟法） | ≈120 ms       | ≈167 ms               | ≈269 ms    |
| 可选码率       | 2/4/8/16 Mbps | 2/4/8/16 Mbps（建议 ≤4M） | 由画质档决定     |
| 主要瓶颈       | 双方 P2P 带宽     | **云服务器转发带宽**          | 服务端编码 + WS |

- **中继带宽是硬瓶颈**：中继码率过高会在快速滚动/翻页等高运动场景拥塞，先掉帧、再降级硬解码、甚至断连。中继建议 2–4 Mbps。
- 直连/中继默认对 WebRTC 输出做 **1920×1080@30** 上限以降低主控端解码压力（硬解码按画质档）。
- 源采集分辨率/帧率为被控机显示器分辨率与 `config.json` 的 `fps`（默认 60）。

## 目录结构

```
agent/           被控机 Agent
  main.py        入口：参数 / 启动服务
  server.py      本地 Web + 登录 + 信令 + WebRTC + H.264 硬解码兜底 + 自适应码率
  capture.py     DXGI 截屏(dxcam) + 鼠标光标叠加（mss 兜底）
  encoder.py     NVENC 编码（WebRTC 轨 + WS Annex-B）
  stream.py      WebRTC 视频轨（支持中继降分辨率/帧率）
  injector.py    SendInput 键鼠注入
  auth.py        令牌 / 登录限速
  config.py      配置读写 / 密码哈希
  turnpatch.py   aioice TURN / Windows UDP 兼容补丁
  config.json    运行配置（含密钥，勿外传，已 gitignore）
web/             主控端浏览器界面（app.js / index.html / style.css / h264worker.js）
scripts/         start_all（一键启动+首次装环境）/ install_autostart（开机自启）/ restart_agent（重启）/ _env（Python 解析）
重启Agent.cmd     双击一键重启 Agent（自动 UAC 提权）
vps/             install.sh（frps+Caddy）、install_turn.sh（coturn 中继）
frp/             frpc.toml（含令牌，已 gitignore）
tools/           frpc.exe 等（自动下载，已 gitignore）
logs/            运行日志（自动生成）
```

## 配置项 `agent/config.json`

| 字段              | 说明                                                      |
| --------------- | ------------------------------------------------------- |
| `host` / `port` | 本地监听（默认 `127.0.0.1:8443`，frpc 连接它）                      |
| `password_hash` | 访问密码哈希（用 `--set-password` 修改）                           |
| `fps`           | 采集帧率（默认 60；WebRTC 直接用，硬解码 WS 输出上限 30）                   |
| `bitrate`       | WebRTC 初始/默认码率（连接后由工具栏「码率」下拉覆盖）                         |
| `monitor`       | 采集的显示器序号（从 0 开始）                                        |
| `session_ttl`   | 登录令牌有效期（秒）                                              |
| `ice_servers`   | WebRTC ICE 服务器（STUN/TURN）——TURN 填 `install_turn.sh` 的输出 |
| `token_secret`  | 自动生成，勿改（改了所有登录令牌失效）                                     |

## 常见问题

**1. 云安全软件把 `frps` / `frpc` 报毒**  
frp 是开源的内网穿透工具，常被 AV 标为 **Riskware/PUA（如 `Linux.Risk.Frpc`）**，属**误报**。  
请把 `/usr/local/bin/frps`（服务器）与 `tools\frpc.exe`（被控机）加入**信任/白名单**，**不要删除**——删了远控公网入口就断了。

**2. 装了 `av` 失败**  
必须带 `--only-binary=:all:`（脚本已处理）。

**3. 画面卡顿 / CPU 占用高**

- 日志确认出现 `NvencH264Encoder active`；若出现 `NVENC 失败，改用 libx264`，说明显卡不支持，降低 `fps`/`bitrate` 或用硬解码兼容模式。
- 主控机无独显时 1080p 软解吃力，硬解码模式请选「流畅/均衡」。

**4. 中继模式卡顿 / 降级 / 断连**  
中继媒体全经云服务器转发，带宽有限。中继码率建议 **2–4 Mbps**；过高会在高运动场景拥塞。要更高画质请用直连（P2P）。

**5. 主控端连不上 / 信令被“已拦截(Blocked)”**  
浏览器广告拦截/隐私扩展或安全软件可能拦截 WebSocket 请求。请把 `https://<你的域名>` 加入其白名单（本项目的信令路径为 `/api/signal`，已尽量避免被通用规则命中）。

**6. WebRTC 连不上**  
内网/对称 NAT 下 P2P 打洞常失败，会自动切 TURN；TURN 也失败则退回硬解码（H.264 over WS），功能不受影响。

**7. 看不到 UAC 弹窗 / 按不了 Ctrl+Alt+Del**

- Ctrl+Alt+Del 属安全桌面，任何用户态软件都无法下发。
- UAC 弹窗需**以管理员身份运行 Agent** 才可见可控。

## 安全说明

- 访问密码以 PBKDF2-SHA256 加盐存储，登录失败指数退避；会话令牌 HMAC 签名、带有效期。
- 对外只暴露云服务器 443（Caddy 终结 TLS）；Agent 与 frps 的 8443 均只绑定本地回环。
- `agent/config.json`、`frp/frpc.toml` 含密钥/令牌，均已 gitignore，请勿外发；**请勿把真实域名/令牌写进仓库**。

## 更新日志

- **近期**：码率下拉（直连/中继 2/4/8/16 Mbps，中继带最低码率地板）、中继稳定性修复（TURN `external-ip=公网/私网`、aioice `send_data` 死锁补丁、Windows UDP `SIO_UDP_CONNRESET` 关闭、中继 `1920×1080@30` 上限）、默认中继优先、信令端点改为 `/api/signal`、一键重启脚本、Python 环境自动解析（.venv/RC_PY）、去除机器特定路径与隐私信息。

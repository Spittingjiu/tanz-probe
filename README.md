# 🚀 Tanz Probe (探针) - 现代化企业级分布式云机群全景监控面板

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Debian / Ubuntu](https://img.shields.io/badge/Platform-Debian%20%7C%20Ubuntu-orange.svg)](#-面板安装要求)
[![Agent: Cross-Platform](https://img.shields.io/badge/Agent-Linux%20%7C%20macOS%20%7C%20OpenWrt-brightgreen.svg)](#-子节点-agent-一键部署)
[![Zero-GC Core](https://img.shields.io/badge/Engine-Zero--GC%2060FPS-blueviolet.svg)](#-核心特性)
[![Go Version](https://img.shields.io/badge/Go-1.26+-00ADD8.svg?logo=go)](agent.go)
[![Node.js](https://img.shields.io/badge/Node.js-20%20LTS-339933.svg?logo=nodedotjs)](server.js)

> **Tanz Probe** 是一款专为极客、运维团队与基础设施发烧友打造的**高颜值、零开销、零频 GC** 分布式机群观测系统。主控面板支持 Debian/Ubuntu 一键安装，子探针支持全平台原生运行，内置全国三网回程诊断、真实原生流媒体/AI 解锁深度测试、月度流量警戒监控以及独特的**面板一键无感热迁移**功能。

---

## ✨ 核心特性

- ⚡ **零频 GC (Zero-Allocation UI & Loop)**：
  - 深度遵循前端 60FPS 渲染准则，图表与高频更新避免动态内存申请；
  - 探针端仅占用个位数 MB 内存，对生产环境业务**零性能干扰**。
- 🖥️ **主控面板原生自纳管 (Zero-Agent on Master)**：
  - 安装面板的机器**自动加入监控大屏**，由面板进程直接读取 `/proc` 核心指标；
  - **无需额外安装子探针**，面板安装脚本自动清理本机冗余 agent，杜绝端口与资源冲突。
- 🔄 **面板后台一键无缝热迁移 (Seamless Hot Migration)**：
  - 在 A 机器后台发起迁移，输入 B 机器地址，即时生成 30 分钟防篡改迁移秘钥；
  - 在 B 机器后台输入秘钥与 A 机器地址，一键拉取全部节点信息、省份点位与流量配置；
  - 所有在线子 Agent 自动感知指令，**瞬间无缝切换重定向至 B 机器上报**，无需逐台手动修改！
  - A 机器交接后优雅休眠断开连接，单机器单面板运行保证数据纯净。
- 🌐 **三网回程网络线路诊断 & 全网流媒体 AI 解锁探测**：
  - 支持节点测速与电信 163、联通 4837、移动 CMI 回程线路诊断；
  - 真实探测 YouTube、Netflix、Disney+、ChatGPT、Claude 原生/DNS 解锁状态并徽章化呈现。
- 📊 **全国 34 省份多线时延与多维雷达**：
  - 深度集成中国电信、中国联通、中国移动三网省份延迟采样与节点综合评分雷达图。
- 🎯 **访客端到节点实时延迟测速 (Client Latency Meter)**：
  - 访客在网页端点击即可测算当前本地网络到各大机房节点的真实 HTTP / Ping 延迟，测速无感轻量。
- 🚨 **月度流量配额与多级预警**：
  - 支持为各节点设定月度总流量上限（GB/TB）及每月重置日期；
  - 实时根据消耗比例显示动态色条（充沛绿、适中蓝、紧张橙、超限红），并支持临界预警。
- 🛡️ **生产级安全防护体系**：
  - 登录防爆破速率限制、IP 脱敏与隐匿保护、自动化生成 16 位强随机初始密码。

---

## 🖥️ 面板安装要求

- **操作系统**：仅支持 **Debian 11/12** 或 **Ubuntu 20.04/22.04/24.04**（LTS 系列）
- **权限**：需要 `root` 用户权限
- **单机器单面板原则**：一台机器只允许安装运行一个主控面板，避免端口与数据库竞争

---

## 🚀 主控面板一键部署 (Debian / Ubuntu 专属)

在你的 Debian 或 Ubuntu 机器上执行以下一行脚本即可全自动部署：

```bash
curl -fsSL https://raw.githubusercontent.com/Spittingjiu/tanz-probe/main/install.sh | bash
```

安装脚本将自动执行：
1. 系统发行版校验（非 Debian 系会自动拒绝并给出提示）；
2. 清理本机已存在的冗余子探针（主控已原生内置纳管）；
3. 安装 Node.js 20 LTS 运行环境与必要系统依赖；
4. 部署 Tanz Probe 面板源码；
5. 生成 16 位高强度随机初始管理密码并配置安全服务守护；
6. 启动 `tanz-probe.service` 并输出大屏与后台访问地址及登录密钥。

### 常用主控管理指令
```bash
# 查看面板运行状态
systemctl status tanz-probe

# 重启主控面板
systemctl restart tanz-probe

# 停止主控面板
systemctl stop tanz-probe

# 查看面板实时日志
journalctl -u tanz-probe -f
```

---

## 📡 子节点 (Agent) 一键部署 (全平台支持)

子探针（Tanz Agent）支持部署在任意平台与操作系统（Linux 各发行版、macOS、OpenWrt 路由器等）。

进入主控面板后台（`http://<主控IP>:3000/admin.html`），在**节点管理**中点击「添加节点」，获取该节点的**通信密钥**。

然后在被监控的目标机器上运行一键安装指令：

```bash
curl -fsSL http://<你的主控IP>:3000/install-agent.sh | bash -s -- --master http://<你的主控IP>:3000 --secret <节点通信密钥>
```

### 参数说明：
| 参数 | 说明 | 示例 |
| :--- | :--- | :--- |
| `-m, --master` | 主控面板的公网访问地址（含端口） | `http://1.2.3.4:3000` |
| `-s, --secret` | 后台该节点对应的独立通信密钥 | `sec_hk_9f3a...` |
| `-i, --id` | 自定义节点唯一标识符（可选，默认自动生成） | `node-hk-01` |
| `--interval` | 采集与上报时间间隔秒数（可选，默认 1.0 秒） | `1.0` |
| `--uninstall` | 彻底停止并卸载此机器上的 Tanz Agent | 无 |

### 支持架构与系统：
- **Linux**：`x86_64` (amd64), `aarch64` (arm64), `armv7l` (armhf), `i386`, `riscv64`
- **macOS**：Apple Silicon (`arm64`), Intel (`x86_64`)
- **软路由与嵌入式**：OpenWrt (`procd` 守护自启), Alpine Linux (`OpenRC`)
- **自动降级容灾**：若系统架构无原生 Go 二进制，脚本自动无缝降级为通用异步 Python 3 轻量探针！

### 一键卸载子探针：
```bash
curl -fsSL http://<你的主控IP>:3000/install-agent.sh | bash -s -- --uninstall
```

---

## 🔄 面板一键无感热迁移实操指南

当需要将主控面板从 **A 机器（旧机器）** 迁移至 **B 机器（新机器）** 时：

```
[旧面板 A 机器]  -- 生成热迁移密钥 -->  [新面板 B 机器]
      ^                                      |
      |-- (向所有子 Agent 下发迁移重定向) <---|
      v                                      v
  [子 Agent 1]       [子 Agent 2]       [子 Agent 3]
       \                  |                 /
        '--------> 全部无缝上报至 B <-------'
```

1. **准备新机器 B**：
   在 B 机器上运行 `install.sh` 安装全新主控面板；
2. **在 A 机器后台发起迁移**：
   - 登录 A 机器后台 `http://A:3000/admin.html`，切换到 **「一键迁移」** 选项卡；
   - 在「发起面板迁移 (A 机器)」中输入 B 机器地址（如 `http://B_IP:3000`），点击 **「生成迁移授权密钥」**；
   - 复制生成的 `mig_sec_xxxxxxxxxxxxxx` 密钥；
3. **在 B 机器后台接管数据**：
   - 登录 B 机器后台 `http://B:3000/admin.html`，切换到 **「一键迁移」** 选项卡；
   - 在「接管并拉取面板 (B 机器)」中输入 A 机器的地址以及刚才复制的迁移密钥；
   - 点击 **「立即验证并一键接管」**；
4. **瞬间完成迁移**：
   - B 机器自动从 A 导入全部节点、Ping 目标、省份线路与流量配置；
   - A 机器状态更新为已迁移，并在子 Agent 下一次心跳（1 秒内）通知其重定向至 B 机器；
   - 所有子探针自动更新本地配置并无缝上报至 B 机器，全网监控**零数据中断**！

---

## 📂 项目工程架构

```
tanz-probe/
├── server.js              # 主控核心服务 (Express + 零频内存池 + 本机自纳管)
├── agent.go               # 原生高性能 Go 微核心子探针源码
├── agent.py               # 通用跨平台 Python 异步备用探针
├── install.sh             # Debian / Ubuntu 主控一键全自动部署脚本
├── install-agent.sh       # 全平台通用子探针安装/更新/卸载脚本
├── public/                # 静态前端资源 (零频 GC 架构大屏)
│   ├── index.html         # 监控大屏主界面
│   ├── app.js             # 大屏前端核心渲染逻辑
│   ├── admin.html         # 强大现代化的管理后台
│   ├── admin.js           # 后台交互与一键热迁移交互逻辑
│   ├── tanz-agent*        # 预编译多架构探针二进制 (amd64, arm64, armv7, darwin)
│   └── icons/             # 真实流媒体/AI 矢量官方图标
├── data/                  # 运行时配置与持久化存储 (JSON 格式)
│   ├── servers.json       # 节点注册列表
│   ├── admin-config.json  # 初始高强度管理员认证凭证
│   └── ping-targets.json  # 测速与三网线路目标配置
└── LICENSE                # MIT 开源授权协议
```

---


---

## 💖 鸣谢与致谢 (Credits & Acknowledgments)

本项目在开发与演进过程中，深度参考并受益于开源社区众多优秀的网络诊断与监控项目，特此致以诚挚的感谢：

1. **全国 31 省份网络时延与测速点位**：
   - 感谢开源网络测速与回程评测社区整理的**中国电信、中国联通、中国移动全国 31 个省份核心骨干网、省网网关与低延迟 DNS 采样端点**，为多维网络雷达拓扑与省份综合评分提供了精准、权威的真实延迟测算依据。
2. **三网回程网络线路诊断 (Backhaul Tracing)**：
   - 感谢开源路由追踪与网络分析工具（[NextTrace](https://github.com/nxt-trace/nexttrace)、[BestTrace](https://www.ipip.net/) 等）关于电信 163 / CN2 GIA、联通 4837 / 9929、移动 CMI 等运营商骨干线路特征跳数识别的开源实践。
3. **原生流媒体与全球 AI 服务解锁深度探测**：
   - 感谢 [Check.so](https://check.so/)、[Media-Unlock](https://github.com/sjlleo/Verify-Netflix)、[TubeCheck](https://github.com/sjlleo/TubeCheck) 及 OpenAI / Claude 测速开源脚本社区关于检测住宅 IP、官方边缘 CDN 可达性与 DNS 解锁状态的判定逻辑。
4. **前端视觉与矢量图标**：
   - [Tailwind CSS](https://tailwindcss.com/) - 现代化实用优先的前端样式引擎
   - [Lucide Icons](https://lucide.dev/) - 清爽优雅的开源系统图标库
   - [SimpleMaps](https://simplemaps.com/) - 高精度全球地理与机房分布矢量底图
   - YouTube、Netflix、Disney+、OpenAI、Anthropic 官方品牌的 SVG 矢量图标

---

## 📜 开源协议

本项目基于 **[MIT License](LICENSE)** 协议开源。欢迎提交 Issue 与 Pull Request！

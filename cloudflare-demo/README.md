# ⚡ Tanz Probe - Cloudflare Workers 极速无服务器演示站

本目录提供了一个**完全独立、零服务器成本、零依赖**的 Cloudflare Workers 演示站方案。

你可以秒级将其部署到 Cloudflare 全球 300+ 边缘机房节点上，获得一个专属的公网 Live Demo 链接（如 `https://tanz-demo.<你的子域>.workers.dev`），用于向朋友、技术社区或 GitHub 访客展示 Tanz Probe 极具视觉冲击力的 60FPS 零频 GC 前端大屏！

---

## 🌟 演示站特色功能

- 🚀 **0 成本 & 0 服务器**：运行在 Cloudflare Workers 免费层（每天 100,000 次请求额度，个人展示完全用不完）；
- 💓 **原生 WebSocket 实时推流**：借助 Cloudflare `WebSocketPair` 实现呼吸式心跳网络推流，全网吞吐、CPU 仪表盘与延迟曲线实时动态起伏；
- 🌐 **7 台跨国顶配机群仿真**：
  - 🇭🇰 香港 BGP 极速互联（Equinix HK2 · CN2 GIA / 9929 / CMI 直连）
  - 🇯🇵 日本 东京 BBTEC 旗舰（Equinix TY8 · 软银 BBTEC 极速互联）
  - 🇺🇸 美国 洛杉矶 CN2 GIA 旗舰（Coresite LA2 · 双程 AS4809）
  - 🇸🇬 新加坡 BGP 亚太中枢（Equinix SG1 · 亚太优化）
  - 🇩🇪 德国 法兰克福 9929（Interxion FRA · 联通 9929 顶级回程）
  - 🇬🇧 英国 伦敦精品网（Telehouse North · 欧洲骨干）
  - 🏠 家里云 私有超融合集群（FTTR 2000M · Proxmox VE 全闪存储）
- 🎬 **原生流媒体与 AI 全绿解锁展示**：真实还原 YouTube Premium、Netflix 4K、Disney+、ChatGPT Plus、Claude 3.5 深度解锁检测矩阵；
- 📈 **全国 31 个省份三网时延与回程线路**：完整支持展开节点详情弹窗，查看全国多线网络雷达图与 1h/6h/24h 历史曲线；
- 🛡️ **安全沙箱保护**：完全只读，不暴露任何真实主控凭证与真实机器 IP，公开分享无后顾之忧。

---

## 🚀 部署方法

### 方式一：Cloudflare 网页控制台（推荐，0 命令行，30 秒搞定）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)；
2. 在左侧导航栏点击 **Workers 和 Pages (Workers & Pages)** -> 点击 **创建 (Create)**；
3. 选择 **创建 Worker (Create Worker)**，输入名称（例如 `tanz-probe-demo`），点击 **部署 (Deploy)**；
4. 部署完成后，点击右上方 **编辑代码 (Edit code)**；
5. 清空编辑器原本的代码，将本目录下的 [`worker.js`](worker.js) **文件全部内容直接全选复制粘贴进去**；
6. 点击右上角的 **保存并部署 (Save and deploy)**；
7. 🎉 大功告成！直接点击分配给你的 `https://tanz-probe-demo.<你的用户名>.workers.dev` 即可查看大屏！

---

### 方式二：Wrangler 命令行一键部署（极客推荐）

如果你本地安装了 Node.js，也可以直接通过 Wrangler 命令行部署：

```bash
# 1. 进入本目录
cd cloudflare-demo

# 2. 登录 Cloudflare 账号 (首次运行需授权)
npx wrangler login

# 3. 一键部署到全球边缘节点
npx wrangler deploy
```

终端将直接输出你的公网在线访问 URL。

---

## 🛠️ 二次开发与前端同步

如果你修改了主项目中的 `public/index.html` 或 `public/app.js`，只需在本目录下运行：

```bash
node build.js
```

构建脚本会自动读取最新前端代码、执行最高级别 Gzip 压缩与 Base64 编码，并无缝写入 `worker.js` 中。

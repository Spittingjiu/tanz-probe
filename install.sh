#!/usr/bin/env bash
# ==============================================================================
# Tanz Probe - Enterprise Zero-GC Cloud Fleet Observer
# Official Debian / Ubuntu One-Click Master Panel Installer
#
# GitHub: https://github.com/Spittingjiu/tanz-probe
# ==============================================================================

set -e

# ANSI Color Codes
COLOR_RESET="\033[0m"
COLOR_BOLD="\033[1m"
COLOR_RED="\033[1;31m"
COLOR_GREEN="\033[1;32m"
COLOR_YELLOW="\033[1;33m"
COLOR_BLUE="\033[1;34m"
COLOR_PURPLE="\033[1;35m"
COLOR_CYAN="\033[1;36m"

echo -e "${COLOR_CYAN}${COLOR_BOLD}"
cat << 'EOF'
  _____                 _____           _          
 |_   _|_ _ _ __  ____ |  __ \         | |         
   | |/ _` | '_ \|_  / | |__) | __ ___ | |__   ___ 
   | | (_| | | | |/ /  |  ___/ '__/ _ \| '_ \ / _ \
   | |\__,_|_| |_/___| | |   | | | (_) | |_) |  __/
   \_/                 |_|   |_|  \___/|_.__/ \___|
  零频 GC · 全局实时探针面板 (Debian/Ubuntu 专用极速版)
EOF
echo -e "${COLOR_RESET}"

# 1. Root Permission Check
if [ "$(id -u)" != "0" ]; then
    echo -e "${COLOR_RED}[错误] 此安装脚本需要 root 用户权限，请使用 sudo bash install.sh 重新执行！${COLOR_RESET}"
    exit 1
fi

# 2. Strict OS Compatibility Check (Debian / Ubuntu Only)
echo -e "${COLOR_BLUE}[1/7] 正在检测系统发行版环境...${COLOR_RESET}"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_LIKE="${ID_LIKE:-}"
else
    echo -e "${COLOR_RED}[错误] 未能检测到 /etc/os-release，当前系统可能不受支持。${COLOR_RESET}"
    exit 1
fi

IS_DEBIAN_FAMILY=false
if [ "$OS_ID" = "debian" ] || [ "$OS_ID" = "ubuntu" ]; then
    IS_DEBIAN_FAMILY=true
elif echo "$OS_LIKE" | grep -qi "debian"; then
    IS_DEBIAN_FAMILY=true
fi

if [ "$IS_DEBIAN_FAMILY" != "true" ]; then
    echo -e "${COLOR_RED}================================================================${COLOR_RESET}"
    echo -e "${COLOR_RED}[系统不支持] Tanz Probe 主控面板仅官方支持 Debian 及 Ubuntu 系列系统！${COLOR_RESET}"
    echo -e "当前系统检测为: ${COLOR_YELLOW}${OS_ID} (${PRETTY_NAME:-Linux})${COLOR_RESET}"
    echo -e "💡 提示: 如果您希望监控此机器，请直接将其作为子节点运行 Tanz Agent 探针："
    echo -e "   curl -fsSL http://<你的主控IP>:3000/install-agent.sh | bash -s -- --master http://<你的主控IP>:3000 --secret <密钥>"
    echo -e "${COLOR_RED}================================================================${COLOR_RESET}"
    exit 1
fi
echo -e "${COLOR_GREEN}✓ 系统环境符合要求: ${PRETTY_NAME:-$OS_ID}${COLOR_RESET}"

# 3. Single Instance Check & Port Conflict Verification
echo -e "${COLOR_BLUE}[2/7] 检查运行环境与端口占用...${COLOR_RESET}"
PORT=3000
PANEL_DIR="/opt/tanz-probe"

if systemctl is-active --quiet tanz-probe 2>/dev/null; then
    echo -e "${COLOR_YELLOW}[提示] 检测到本机已运行 Tanz Probe 面板服务 (tanz-probe.service)。${COLOR_RESET}"
    echo -e "为确保服务稳定并杜绝数据写冲突，单台机器仅允许安装一个面板。"
    read -r -p "是否更新并重新安装至最新版本？(y/N): " choice
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        echo -e "${COLOR_YELLOW}正在停止当前正在运行的面板实例...${COLOR_RESET}"
        systemctl stop tanz-probe 2>/dev/null || true
    else
        echo -e "${COLOR_GREEN}已取消安装，现有面板继续运行。${COLOR_RESET}"
        exit 0
    fi
fi

# Check if port 3000 is occupied by other processes
if command -v ss >/dev/null 2>&1; then
    PORT_CHECK=$(ss -tulpn | grep ":${PORT} " || true)
elif command -v netstat >/dev/null 2>&1; then
    PORT_CHECK=$(netstat -tulpn | grep ":${PORT} " || true)
else
    PORT_CHECK=""
fi

if [ -n "$PORT_CHECK" ]; then
    echo -e "${COLOR_RED}[警告] 端口 ${PORT} 已被其他程序占用: ${PORT_CHECK}${COLOR_RESET}"
    echo -e "请先释放该端口，或在安装后修改环境配置。"
fi

# 4. Clean up any redundant sub-agent on Master Host
echo -e "${COLOR_BLUE}[3/7] 清理本机冗余子探针 (主控内置零频监控，无需子探针)...${COLOR_RESET}"
if systemctl is-active --quiet tanz-agent 2>/dev/null || [ -f /etc/systemd/system/tanz-agent.service ] || [ -d /opt/tanz-agent ]; then
    echo -e "${COLOR_CYAN}发现本机运行了 tanz-agent。主控面板已自带原生零开销监控采集，正在自动卸载清理...${COLOR_RESET}"
    systemctl stop tanz-agent 2>/dev/null || true
    systemctl disable tanz-agent 2>/dev/null || true
    rm -f /etc/systemd/system/tanz-agent.service
    systemctl daemon-reload 2>/dev/null || true
    rm -rf /opt/tanz-agent
    echo -e "${COLOR_GREEN}✓ 本机冗余子探针已彻底清理并释放资源。${COLOR_RESET}"
else
    echo -e "${COLOR_GREEN}✓ 本机环境干净，无冲突子探针。${COLOR_RESET}"
fi

# 5. Install System Prerequisites and Node.js 20 LTS
echo -e "${COLOR_BLUE}[4/7] 安装系统基础依赖与 Node.js 运行环境...${COLOR_RESET}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -q
apt-get install -y -q curl wget tar git procps ca-certificates gnupg

# Check Node.js version
INSTALL_NODE=false
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d'.' -f1)
    if [ "$NODE_VER" -lt 18 ]; then
        INSTALL_NODE=true
    fi
else
    INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = "true" ]; then
    echo -e "${COLOR_CYAN}正在配置 Node.js 20 LTS 官方源...${COLOR_RESET}"
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes 2>/dev/null || true
    NODE_MAJOR=20
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    apt-get update -y -q
    apt-get install -y -q nodejs
fi
echo -e "${COLOR_GREEN}✓ Node.js 环境就绪: $(node -v) (npm: $(npm -v))${COLOR_RESET}"

# 6. Deploy Code and Configure Strong Password
echo -e "${COLOR_BLUE}[5/7] 部署 Tanz Probe 面板程序及初始化数据...${COLOR_RESET}"
mkdir -p "$PANEL_DIR"
cd "$PANEL_DIR"

# If current directory doesn't have server.js, clone from GitHub
if [ ! -f "$PANEL_DIR/server.js" ]; then
    echo -e "${COLOR_CYAN}正在从 GitHub 克隆主控面板源码...${COLOR_RESET}"
    git clone https://github.com/Spittingjiu/tanz-probe.git "$PANEL_DIR" 2>/dev/null || {
        echo -e "${COLOR_YELLOW}Git 克隆失败，尝试拉取压缩包...${COLOR_RESET}"
        curl -fsSL https://github.com/Spittingjiu/tanz-probe/archive/refs/heads/main.tar.gz | tar -xz --strip-components=1 -C "$PANEL_DIR"
    }
fi

mkdir -p "$PANEL_DIR/data"
mkdir -p "$PANEL_DIR/public"

# Admin Password Initialization
ADMIN_CONFIG="$PANEL_DIR/data/admin-config.json"
STRONG_PASSWORD=""
IS_NEW_PASS=false

if [ ! -f "$ADMIN_CONFIG" ]; then
    # Generate cryptographically secure 16-character strong password
    STRONG_PASSWORD=$(tr -dc 'A-Za-z0-9!@#%^&*' < /dev/urandom 2>/dev/null | head -c 16 || true)
    if [ -z "$STRONG_PASSWORD" ] || [ ${#STRONG_PASSWORD} -lt 12 ]; then
        STRONG_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(8).toString('hex') + 'A#9')")
    fi
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    
    cat > "$ADMIN_CONFIG" << EOF
{
  "username": "admin",
  "password": "${STRONG_PASSWORD}",
  "jwtSecret": "${JWT_SECRET}",
  "initializedAt": $(date +%s),
  "forcePasswordChange": false
}
EOF
    chmod 600 "$ADMIN_CONFIG"
    IS_NEW_PASS=true
else
    # Read existing password
    STRONG_PASSWORD=$(node -e "try { const c = JSON.parse(require('fs').readFileSync('$ADMIN_CONFIG')); console.log(c.password); } catch(e){}" 2>/dev/null || echo "(保持原有密码)")
fi

# 7. Create Systemd Service and Start Panel
echo -e "${COLOR_BLUE}[6/7] 配置 Systemd 后台服务守护...${COLOR_RESET}"
NODE_BIN=$(which node)

cat > /etc/systemd/system/tanz-probe.service << EOF
[Unit]
Description=Tanz Probe Enterprise Cloud Fleet Observer
Documentation=https://github.com/Spittingjiu/tanz-probe
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${PANEL_DIR}
ExecStart=${NODE_BIN} ${PANEL_DIR}/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535
Environment=NODE_ENV=production
Environment=PORT=${PORT}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tanz-probe

# Wait for service to come up
echo -e "${COLOR_BLUE}[7/7] 等待服务初始化与端口监听...${COLOR_RESET}"
sleep 2

# Detect Server IP
SERVER_IP=$(curl -fsSL --connect-timeout 3 https://api.ipify.org 2>/dev/null || \
           curl -fsSL --connect-timeout 3 https://ifconfig.me 2>/dev/null || \
           hostname -I | awk '{print $1}')

if systemctl is-active --quiet tanz-probe; then
    echo -e "${COLOR_GREEN}${COLOR_BOLD}========================================================================${COLOR_RESET}"
    echo -e "${COLOR_GREEN}${COLOR_BOLD}           🎉 恭喜！Tanz Probe 主控面板已成功安装并运行！               ${COLOR_RESET}"
    echo -e "${COLOR_GREEN}${COLOR_BOLD}========================================================================${COLOR_RESET}"
    echo -e ""
    echo -e "  🌐 监控大屏前台:  ${COLOR_CYAN}http://${SERVER_IP}:${PORT}/${COLOR_RESET}"
    echo -e "  🔐 管理控制后台:  ${COLOR_CYAN}http://${SERVER_IP}:${PORT}/admin.html${COLOR_RESET}"
    echo -e "  👤 默认管理账号:  ${COLOR_BOLD}admin${COLOR_RESET}"
    if [ "$IS_NEW_PASS" = "true" ]; then
        echo -e "  🔑 初始随机强密码: ${COLOR_YELLOW}${COLOR_BOLD}${STRONG_PASSWORD}${COLOR_RESET} (请立即复制妥善保存！)"
    else
        echo -e "  🔑 现有管理密码:   ${COLOR_YELLOW}${COLOR_BOLD}${STRONG_PASSWORD}${COLOR_RESET}"
    fi
    echo -e ""
    echo -e "  💻 本机状态:       ${COLOR_GREEN}已自动纳管至面板 (零开销原生采集，无需安装子探针)${COLOR_RESET}"
    echo -e ""
    echo -e "${COLOR_BOLD}------------------------------------------------------------------------${COLOR_RESET}"
    echo -e "${COLOR_BOLD}📌 子节点（监控机器）一键部署指令（支持各类 Linux / macOS / 路由系统）：${COLOR_RESET}"
    echo -e "  ${COLOR_YELLOW}curl -fsSL http://${SERVER_IP}:${PORT}/install-agent.sh | bash -s -- --master http://${SERVER_IP}:${PORT} --secret <在后台添加节点后获取的密钥>${COLOR_RESET}"
    echo -e ""
    echo -e "${COLOR_BOLD}常用服务管理指令：${COLOR_RESET}"
    echo -e "  查看状态:   ${COLOR_CYAN}systemctl status tanz-probe${COLOR_RESET}"
    echo -e "  重启面板:   ${COLOR_CYAN}systemctl restart tanz-probe${COLOR_RESET}"
    echo -e "  实时日志:   ${COLOR_CYAN}journalctl -u tanz-probe -f${COLOR_RESET}"
    echo -e "${COLOR_GREEN}${COLOR_BOLD}========================================================================${COLOR_RESET}"
else
    echo -e "${COLOR_RED}[错误] tanz-probe 服务未能成功启动，请执行 'journalctl -u tanz-probe -e' 查看详细日志排查。${COLOR_RESET}"
    exit 1
fi

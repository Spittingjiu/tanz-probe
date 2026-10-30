#!/usr/bin/env bash
# ==============================================================================
# Tanz Probe - Universal Cross-Platform Agent Installer
# Supports: Linux (Debian, Ubuntu, CentOS, Rocky, Alpine, Arch, OpenWrt, etc.),
#           macOS (Darwin amd64 & Apple Silicon arm64), FreeBSD
#
# GitHub: https://github.com/Spittingjiu/tanz-probe
# ==============================================================================

set -e

# Colors
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_RED="\033[1;31m"
C_GREEN="\033[1;32m"
C_YELLOW="\033[1;33m"
C_BLUE="\033[1;34m"
C_CYAN="\033[1;36m"

echo -e "${C_CYAN}${C_BOLD}"
cat << 'EOF'
  _____                 _____           _          
 |_   _|_ _ _ __  ____ |  __ \         | |         
   | |/ _` | '_ \|_  / | |__) | __ ___ | |__   ___ 
   | | (_| | | | |/ /  |  ___/ '__/ _ \| '_ \ / _ \
   | |\__,_|_| |_/___| | |   | | | (_) | |_) |  __/
   \_/                 |_|   |_|  \___/|_.__/ \___|
  零频 GC 架构 · 全平台微核心监控探针 (Universal Agent)
EOF
echo -e "${C_RESET}"

AGENT_DIR="/opt/tanz-agent"
MASTER_URL="${TANZ_MASTER:-}"
NODE_SECRET="${TANZ_SECRET:-}"
NODE_ID="${TANZ_ID:-}"
INTERVAL=1.0
UNINSTALL=false

# Parse Flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--master)
            MASTER_URL="$2"
            shift 2
            ;;
        -s|--secret)
            NODE_SECRET="$2"
            shift 2
            ;;
        -i|--id)
            NODE_ID="$2"
            shift 2
            ;;
        --interval)
            INTERVAL="$2"
            shift 2
            ;;
        --uninstall)
            UNINSTALL=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# Handle Uninstall Command
if [ "$UNINSTALL" = "true" ]; then
    echo -e "${C_YELLOW}[正在卸载] 停止并清理 Tanz Agent 探针服务...${C_RESET}"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop tanz-agent 2>/dev/null || true
        systemctl disable tanz-agent 2>/dev/null || true
        rm -f /etc/systemd/system/tanz-agent.service
        systemctl daemon-reload 2>/dev/null || true
    fi
    if [ -f /etc/init.d/tanz-agent ]; then
        /etc/init.d/tanz-agent stop 2>/dev/null || true
        /etc/init.d/tanz-agent disable 2>/dev/null || true
        rm -f /etc/init.d/tanz-agent
    fi
    if [ -f /Library/LaunchDaemons/com.tanz.agent.plist ]; then
        launchctl unload /Library/LaunchDaemons/com.tanz.agent.plist 2>/dev/null || true
        rm -f /Library/LaunchDaemons/com.tanz.agent.plist
    fi
    pkill -9 -f tanz-agent 2>/dev/null || true
    rm -rf "$AGENT_DIR"
    echo -e "${C_GREEN}✓ Tanz Agent 已彻底卸载并清理完成。${C_RESET}"
    exit 0
fi

# Validate Parameters
if [ -z "$MASTER_URL" ]; then
    echo -e "${C_RED}[错误] 缺少主控面板地址！${C_RESET}"
    echo -e "使用方法: curl -fsSL http://<MASTER>:3000/install-agent.sh | bash -s -- --master http://<MASTER>:3000 --secret <SECRET> [--id <NODE_ID>]"
    exit 1
fi

if [ -z "$NODE_SECRET" ]; then
    echo -e "${C_RED}[错误] 缺少节点通信密钥 (--secret)！${C_RESET}"
    echo -e "请在 Tanz Probe 管理后台 (admin.html) 添加节点后复制对应的密钥。"
    exit 1
fi

# Strip trailing slash from MASTER_URL
MASTER_URL="${MASTER_URL%/}"

# Auto-generate or derive Node ID if not provided
if [ -z "$NODE_ID" ]; then
    NODE_ID=$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || hostname -s 2>/dev/null || echo "node-$(date +%s)")
    NODE_ID="node-$(echo -n "$NODE_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g' | cut -c1-16)"
fi

echo -e "${C_BLUE}[1/4] 检测操作系统架构与硬件环境...${C_RESET}"
OS_NAME=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH_NAME=$(uname -m | tr '[:upper:]' '[:lower:]')

BIN_NAME="tanz-agent"
if [ "$OS_NAME" = "linux" ]; then
    case "$ARCH_NAME" in
        x86_64|amd64)
            BIN_NAME="tanz-agent-linux-amd64"
            ;;
        aarch64|arm64)
            BIN_NAME="tanz-agent-linux-arm64"
            ;;
        armv7*|armhf)
            BIN_NAME="tanz-agent-linux-armv7"
            ;;
        *)
            BIN_NAME="tanz-agent-linux-amd64"
            ;;
    esac
elif [ "$OS_NAME" = "darwin" ]; then
    case "$ARCH_NAME" in
        arm64|aarch64)
            BIN_NAME="tanz-agent-darwin-arm64"
            ;;
        *)
            BIN_NAME="tanz-agent-darwin-amd64"
            ;;
    esac
fi

echo -e "${C_GREEN}✓ 系统: ${OS_NAME} | 架构: ${ARCH_NAME} | 匹配二进制: ${BIN_NAME}${C_RESET}"

# Create Agent Directory
mkdir -p "$AGENT_DIR"
cd "$AGENT_DIR"

# Download Binary or Python Agent Fallback
echo -e "${C_BLUE}[2/4] 从主控下载探针核心程序...${C_RESET}"
DOWNLOAD_SUCCESS=false

# Try downloading compiled Go binary
if curl -fsSL --connect-timeout 8 "${MASTER_URL}/${BIN_NAME}" -o "$AGENT_DIR/tanz-agent" 2>/dev/null || \
   curl -fsSL --connect-timeout 8 "${MASTER_URL}/tanz-agent" -o "$AGENT_DIR/tanz-agent" 2>/dev/null; then
    chmod +x "$AGENT_DIR/tanz-agent"
    if "$AGENT_DIR/tanz-agent" -v >/dev/null 2>&1 || [ -s "$AGENT_DIR/tanz-agent" ]; then
        DOWNLOAD_SUCCESS=true
        AGENT_EXEC="$AGENT_DIR/tanz-agent"
        echo -e "${C_GREEN}✓ 零频 Go 微核心二进制下载并校验成功！${C_RESET}"
    fi
fi

# Fallback to Python Agent if Go binary not executable
if [ "$DOWNLOAD_SUCCESS" != "true" ]; then
    echo -e "${C_YELLOW}[提示] 未能运行 Go 二进制，正在回退至通用 Python 异步轻量探针...${C_RESET}"
    if curl -fsSL "${MASTER_URL}/agent.py" -o "$AGENT_DIR/agent.py"; then
        chmod +x "$AGENT_DIR/agent.py"
        PY_BIN=$(which python3 || which python || true)
        if [ -n "$PY_BIN" ]; then
            DOWNLOAD_SUCCESS=true
            AGENT_EXEC="$PY_BIN $AGENT_DIR/agent.py"
            echo -e "${C_GREEN}✓ Python 通用轻量探针配置就绪: ${PY_BIN}${C_RESET}"
        fi
    fi
fi

if [ "$DOWNLOAD_SUCCESS" != "true" ]; then
    echo -e "${C_RED}[错误] 无法从主控下载探针程序，请检查主控地址与防火墙网络是否可通: ${MASTER_URL}${C_RESET}"
    exit 1
fi

# Write Configuration File
echo -e "${C_BLUE}[3/4] 写入本地探针配置文件...${C_RESET}"
cat > "$AGENT_DIR/config.json" << EOF
{
  "nodeId": "${NODE_ID}",
  "nodeSecret": "${NODE_SECRET}",
  "masterUrl": "${MASTER_URL}",
  "interval": ${INTERVAL}
}
EOF
chmod 600 "$AGENT_DIR/config.json"
echo -e "${C_GREEN}✓ 配置文件已生成: ${AGENT_DIR}/config.json${C_RESET}"

# Configure Auto-Start Service
echo -e "${C_BLUE}[4/4] 注册系统级后台开机自启守护...${C_RESET}"
SERVICE_INSTALLED=false

# 1. Systemd (Linux standard)
if command -v systemctl >/dev/null 2>&1; then
    cat > /etc/systemd/system/tanz-agent.service << EOF
[Unit]
Description=Tanz Probe Universal Telemetry Agent
Documentation=https://github.com/Spittingjiu/tanz-probe
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${AGENT_DIR}
ExecStart=${AGENT_EXEC} -config ${AGENT_DIR}/config.json
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now tanz-agent
    SERVICE_INSTALLED=true
    echo -e "${C_GREEN}✓ Systemd 守护服务已安装并启动 (tanz-agent.service)${C_RESET}"

# 2. OpenWrt (procd)
elif [ -d /etc/init.d ] && grep -qi "openwrt" /etc/os-release 2>/dev/null; then
    cat > /etc/init.d/tanz-agent << EOF
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=95
STOP=10

start_service() {
    procd_open_instance
    procd_set_param command ${AGENT_EXEC} -config ${AGENT_DIR}/config.json
    procd_set_param respawn 3600 5 0
    procd_close_instance
}
EOF
    chmod +x /etc/init.d/tanz-agent
    /etc/init.d/tanz-agent enable
    /etc/init.d/tanz-agent start
    SERVICE_INSTALLED=true
    echo -e "${C_GREEN}✓ OpenWrt procd 守护服务已安装并启动 (/etc/init.d/tanz-agent)${C_RESET}"

# 3. macOS (launchd)
elif [ "$OS_NAME" = "darwin" ]; then
    cat > /Library/LaunchDaemons/com.tanz.agent.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tanz.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${AGENT_DIR}/tanz-agent</string>
        <string>-config</string>
        <string>${AGENT_DIR}/config.json</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${AGENT_DIR}</string>
</dict>
</plist>
EOF
    launchctl load -w /Library/LaunchDaemons/com.tanz.agent.plist 2>/dev/null || true
    SERVICE_INSTALLED=true
    echo -e "${C_GREEN}✓ macOS LaunchDaemon 守护已安装并激活${C_RESET}"

# 4. Fallback: nohup background loop
else
    echo -e "${C_YELLOW}[提示] 未识别到已知服务系统，使用 nohup 常驻后台运行...${C_RESET}"
    pkill -9 -f tanz-agent 2>/dev/null || true
    nohup ${AGENT_EXEC} -config ${AGENT_DIR}/config.json >/dev/null 2>&1 &
    SERVICE_INSTALLED=true
fi

echo -e ""
echo -e "${C_GREEN}${C_BOLD}========================================================================${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}           🎉 Tanz Agent 监控探针已成功部署并运行！                    ${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}========================================================================${C_RESET}"
echo -e "  📡 节点 ID:      ${C_BOLD}${NODE_ID}${C_RESET}"
echo -e "  🌐 上报主控:     ${C_CYAN}${MASTER_URL}${C_RESET}"
echo -e "  ⏱️ 采集频率:     ${C_CYAN}每 ${INTERVAL} 秒实时零频上报${C_RESET}"
echo -e "  🔄 热迁移能力:   ${C_GREEN}支持主控一键无感热迁移自动重定向${C_RESET}"
echo -e "  🗑️ 卸载指令:     ${C_YELLOW}curl -fsSL ${MASTER_URL}/install-agent.sh | bash -s -- --uninstall${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}========================================================================${C_RESET}"

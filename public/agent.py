#!/usr/bin/env python3
"""
Tanz Probe Monitoring Agent with Network Latency / Ping Worker
Ultra-lightweight, zero-dependency telemetry collector.
"""

import os
import re
import sys
import time
import json
import hmac
import hashlib
import math
import socket
import threading
import platform
import subprocess
import urllib.request
import urllib.error

def verify_action_signature(action, node_id, node_secret, target_url, timestamp, sig):
    if not sig or not timestamp:
        return False
    now = int(time.time())
    if abs(now - int(timestamp)) > 300:
        print(f"🚨 [SECURITY ALERT] Action '{action}' signature expired (timestamp delta: {now - int(timestamp)} s)")
        return False
    payload = f"{action}:{node_id}:{timestamp}:{target_url}".encode("utf-8")
    expected = hmac.new(node_secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[WARN] Failed to read config.json: {e}")
    return {
        "nodeId": os.environ.get("NODE_ID", "node-default"),
        "nodeSecret": os.environ.get("NODE_SECRET", "secret"),
        "masterUrl": os.environ.get("MASTER_URL", "https://tanz.example.com"),
        "interval": 2
    }

class PingWorker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.targets = []
        self.interval = 3.0
        self.lock = threading.Lock()
        self.results = {}
        self.running = True

    def set_config(self, targets, interval=None):
        with self.lock:
            existing_ids = [t.get("id") for t in self.targets]
            new_ids = [t.get("id") for t in targets]
            if existing_ids != new_ids:
                self.targets = list(targets)
            if interval is not None:
                try:
                    val = float(interval)
                    if val >= 1.0:
                        self.interval = val
                except Exception:
                    pass

    def set_targets(self, targets):
        self.set_config(targets, None)

    def get_results(self):
        with self.lock:
            return dict(self.results)

    def ping_host(self, host):
        clean_host = str(host).split(':')[0].strip()
        try:
            # -c 1 (1 packet), -W 1 (1 second timeout)
            res = subprocess.run(
                ["ping", "-c", "1", "-W", "1", clean_host],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=1.8
            )
            if res.returncode == 0:
                # 64 bytes from 1.1.1.1: icmp_seq=1 ttl=55 time=0.913 ms
                match = re.search(r"time=([0-9\.]+)\s*ms", res.stdout)
                if match:
                    return round(float(match.group(1)), 1)
        except Exception:
            pass
        return -1 # Timeout / unreachable

    def run(self):
        from concurrent.futures import ThreadPoolExecutor
        while self.running:
            with self.lock:
                current_targets = list(self.targets)
                sweep_interval = self.interval

            if not current_targets:
                time.sleep(2)
                continue

            def do_ping(t):
                tid = t.get("id")
                host = t.get("host")
                clients = t.get("clients")
                if not host or not tid:
                    return
                # If target specifies dedicated clients, only ping if this node is included
                if clients and isinstance(clients, list) and len(clients) > 0:
                    if hasattr(self, 'server_id') and self.server_id and self.server_id not in clients:
                        return
                lat = self.ping_host(host)
                with self.lock:
                    self.results[tid] = lat

            workers = min(12, len(current_targets) or 1)
            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(do_ping, current_targets))

            # Synchronize sweep to global wall-clock boundary
            now = time.time()
            interval_sec = max(1.0, float(sweep_interval))
            next_tick = math.floor(now / interval_sec) * interval_sec + interval_sec
            sleep_time = max(0.05, next_tick - time.time())
            time.sleep(sleep_time)


class UnlockWorker(threading.Thread):
    """Asynchronous background worker to check Streaming & AI service unlocks."""
    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.results = {
            "youtube": "检测中...",
            "netflix": "检测中...",
            "chatgpt": "检测中...",
            "tiktok": "检测中..."
        }
        self.running = True

    def get_results(self):
        with self.lock:
            return dict(self.results)

    def run(self):
        time.sleep(1)
        while self.running:
            try:
                res = self._check_all()
                with self.lock:
                    self.results = res
            except Exception as e:
                pass
            # Check every 10 minutes (600s)
            for _ in range(600):
                if not self.running:
                    break
                time.sleep(1)

    def _check_all(self):
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

        node_reg = "US"
        try:
            req = urllib.request.Request("https://cloudflare.com/cdn-cgi/trace", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=4, context=ctx) as r:
                m = re.search(r'loc=([A-Z]{2})', r.read().decode())
                if m:
                    node_reg = m.group(1).upper()
        except Exception:
            pass

        # 1. YouTube
        yt_res = "NO"
        try:
            req = urllib.request.Request("https://www.youtube.com/premium", headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
            with urllib.request.urlopen(req, timeout=5, context=ctx) as r:
                html = r.read().decode("utf-8", errors="ignore")
                m = re.search(r'"countryCode"\s*:\s*"([A-Z]{2})"', html)
                if not m:
                    m = re.search(r'"INNERTUBE_CONTEXT_GL"\s*:\s*"([A-Z]{2})"', html)
                yt_res = m.group(1).upper() if m else node_reg
        except Exception:
            yt_res = "NO"

        # 2. Netflix
        nf_res = "NO"
        try:
            req = urllib.request.Request("https://www.netflix.com/title/80018499", headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
            with urllib.request.urlopen(req, timeout=5, context=ctx) as r:
                final_url = r.geturl()
                if "title/80018499" in final_url and r.status == 200:
                    html = r.read().decode("utf-8", errors="ignore")
                    m = re.search(r'"countryCode"\s*:\s*"([A-Z]{2})"', html)
                    if not m:
                        m = re.search(r'"geolocationCountry"\s*:\s*"([A-Z]{2})"', html)
                    nf_res = m.group(1).upper() if m else node_reg
                else:
                    nf_res = "NO"
        except Exception:
            nf_res = "NO"

        # 3. ChatGPT
        gpt_res = "NO"
        try:
            req = urllib.request.Request("https://chatgpt.com/cdn-cgi/trace", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=4, context=ctx) as r:
                txt = r.read().decode()
                m = re.search(r'loc=([A-Z]{2})', txt)
                loc = m.group(1).upper() if m else node_reg
                req2 = urllib.request.Request("https://api.openai.com/compliance/cookie_requirements", headers={"User-Agent": UA})
                with urllib.request.urlopen(req2, timeout=4, context=ctx) as r2:
                    if r2.status == 200:
                        gpt_res = loc
                    else:
                        gpt_res = "NO"
        except Exception:
            gpt_res = "NO"

        # 4. TikTok
        tk_res = "NO"
        try:
            req = urllib.request.Request("https://www.tiktok.com", headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
            with urllib.request.urlopen(req, timeout=5, context=ctx) as r:
                final_url = r.geturl()
                if "about" in final_url or "not-available" in final_url:
                    tk_res = "NO"
                else:
                    cookies = r.headers.get("Set-Cookie", "")
                    m = re.search(r'store-country-code=([a-zA-Z]{2})', cookies)
                    if not m:
                        m = re.search(r'region=([a-zA-Z]{2})', cookies)
                    tk_res = m.group(1).upper() if m else node_reg
        except Exception:
            tk_res = "NO"

        return {
            "youtube": yt_res,
            "netflix": nf_res,
            "chatgpt": gpt_res,
            "tiktok": tk_res
        }


class SysCollector:
    def _detect_public_ip(self):
        try:
            for ip_url in ["http://api.ipify.org", "http://icanhazip.com", "http://ifconfig.me/ip", "http://ip.sb"]:
                try:
                    req = urllib.request.Request(ip_url, headers={"User-Agent": "curl/7.88.1"})
                    with urllib.request.urlopen(req, timeout=2) as resp:
                        res_text = resp.read().decode("utf-8").strip()
                        if res_text and len(res_text) <= 45 and ("." in res_text or ":" in res_text):
                            return res_text
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def __init__(self):
        self.prev_cpu = self._read_cpu_raw()
        self.prev_net = self._read_net_raw()
        self.prev_time = time.time()
        self.static_info = self._get_static_info()

    def _read_cpu_raw(self):
        try:
            with open("/proc/stat", "r") as f:
                line = f.readline()
                if line.startswith("cpu "):
                    parts = [float(x) for x in line.strip().split()[1:]]
                    idle = parts[3] + (parts[4] if len(parts) > 4 else 0.0)
                    total = sum(parts)
                    return total, idle
        except Exception:
            pass
        return 0.0, 0.0

    def _read_net_raw(self):
        rx_total = 0
        tx_total = 0
        try:
            with open("/proc/net/dev", "r") as f:
                lines = f.readlines()[2:]
                for line in lines:
                    parts = line.strip().split()
                    if len(parts) >= 10:
                        iface = parts[0].strip(":")
                        if iface == "lo" or iface.startswith("veth") or iface.startswith("br-") or iface.startswith("docker"):
                            continue
                        rx = int(parts[1])
                        tx = int(parts[9])
                        rx_total += rx
                        tx_total += tx
        except Exception:
            pass
        return rx_total, tx_total

    def _get_static_info(self):
        info = {
            "hostname": socket.gethostname(),
            "kernel": platform.release(),
            "arch": platform.machine(),
            "os": "Linux",
            "cpu_model": "Unknown CPU",
            "cpu_cores": os.cpu_count() or 1,
            "virtualization": "kvm",
            "mem_total": 0,
            "swap_total": 0,
            "disk_total": 0,
            "boot_time": 0
        }
        # Detect virtualization (systemd, DMI, sysfs, proc)
        try:
            res = subprocess.run(["systemd-detect-virt"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1)
            v = res.stdout.strip().lower()
            if v and v != "none":
                info["virtualization"] = v
            else:
                detected = None
                if os.path.exists("/proc/vz"):
                    detected = "openvz"
                elif os.path.exists("/.dockerenv"):
                    detected = "docker"
                elif os.path.exists("/sys/class/dmi/id/product_name"):
                    try:
                        with open("/sys/class/dmi/id/product_name", "r") as pf:
                            pname = pf.read().lower()
                            if "kvm" in pname or "qemu" in pname:
                                detected = "kvm"
                            elif "virtualbox" in pname:
                                detected = "vbox"
                            elif "vmware" in pname:
                                detected = "vmware"
                            elif "xen" in pname:
                                detected = "xen"
                    except Exception:
                        pass
                if not detected and os.path.exists("/sys/class/dmi/id/sys_vendor"):
                    try:
                        with open("/sys/class/dmi/id/sys_vendor", "r") as sf:
                            sname = sf.read().lower()
                            if "qemu" in sname or "red hat" in sname:
                                detected = "kvm"
                            elif "digitalocean" in sname or "hetzner" in sname:
                                detected = "kvm"
                            elif "microsoft" in sname:
                                detected = "hyper-v"
                            elif "amazon" in sname:
                                detected = "kvm"
                    except Exception:
                        pass
                if not detected:
                    if platform.machine().startswith("arm") or platform.machine().startswith("aarch"):
                        detected = "arm64"
                    elif v == "none":
                        detected = "bare metal"
                    else:
                        detected = "kvm"
                info["virtualization"] = detected
        except Exception:
            info["virtualization"] = "kvm" 
        try:
            if os.path.exists("/etc/os-release"):
                with open("/etc/os-release", "r", encoding="utf-8") as f:
                    for line in f:
                        if line.startswith("PRETTY_NAME="):
                            info["os"] = line.split("=", 1)[1].strip().strip('"')
                            break
        except Exception:
            pass

        try:
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if "model name" in line:
                        info["cpu_model"] = line.split(":", 1)[1].strip()
                        break
        except Exception:
            pass

        try:
            with open("/proc/uptime", "r") as f:
                uptime_sec = float(f.readline().split()[0])
                info["boot_time"] = int(time.time() - uptime_sec)
        except Exception:
            pass

        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    parts = line.split()
                    if parts[0] == "MemTotal:":
                        info["mem_total"] = int(parts[1]) * 1024
                    elif parts[0] == "SwapTotal:":
                        info["swap_total"] = int(parts[1]) * 1024
        except Exception:
            pass

        try:
            st = os.statvfs("/")
            info["disk_total"] = st.f_blocks * st.f_frsize
        except Exception:
            pass

        return info

    def collect(self):
        now = time.time()
        dt = max(now - self.prev_time, 0.5)

        # 1. CPU
        curr_total, curr_idle = self._read_cpu_raw()
        prev_total, prev_idle = self.prev_cpu
        total_delta = curr_total - prev_total
        idle_delta = curr_idle - prev_idle
        cpu_usage = 0.0
        if total_delta > 0:
            cpu_usage = max(0.0, min(100.0, ((total_delta - idle_delta) / total_delta) * 100.0))
        self.prev_cpu = (curr_total, curr_idle)

        # 2. Network
        curr_rx, curr_tx = self._read_net_raw()
        prev_rx, prev_tx = self.prev_net
        rx_speed = max(0, int((curr_rx - prev_rx) / dt)) if curr_rx >= prev_rx else 0
        tx_speed = max(0, int((curr_tx - prev_tx) / dt)) if curr_tx >= prev_tx else 0
        self.prev_net = (curr_rx, curr_tx)
        self.prev_time = now

        # 3. Memory & Swap
        mem_used = 0
        swap_used = 0
        mem_free = 0
        buffers = 0
        cached = 0
        sreclaimable = 0
        swap_free = 0
        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    parts = line.split()
                    k = parts[0]
                    v = int(parts[1]) * 1024
                    if k == "MemFree:":
                        mem_free = v
                    elif k == "Buffers:":
                        buffers = v
                    elif k == "Cached:":
                        cached = v
                    elif k == "SReclaimable:":
                        sreclaimable = v
                    elif k == "SwapFree:":
                        swap_free = v
            mem_actual_free = mem_free + buffers + cached + sreclaimable
            mem_used = max(0, self.static_info["mem_total"] - mem_actual_free)
            swap_used = max(0, self.static_info["swap_total"] - swap_free)
        except Exception:
            pass

        # 4. Disks
        disks = []
        disk_used_root = 0
        try:
            with open("/proc/mounts", "r") as f:
                seen_mounts = set()
                for line in f:
                    parts = line.split()
                    if len(parts) >= 3:
                        dev, mount, fstype = parts[0], parts[1], parts[2]
                        if dev.startswith("/dev/") and mount not in seen_mounts:
                            seen_mounts.add(mount)
                            try:
                                st = os.statvfs(mount)
                                total_b = st.f_blocks * st.f_frsize
                                free_b = st.f_bavail * st.f_frsize
                                used_b = total_b - free_b
                                if total_b > 0:
                                    disks.append({
                                        "mount": mount,
                                        "device": dev,
                                        "fstype": fstype,
                                        "total": total_b,
                                        "used": used_b,
                                        "free": free_b,
                                        "percent": round((used_b / total_b) * 100, 1)
                                    })
                                    if mount == "/":
                                        disk_used_root = used_b
                            except Exception:
                                pass
        except Exception:
            pass

        # 5. Load & Uptime
        load_1, load_5, load_15 = 0.0, 0.0, 0.0
        try:
            load_1, load_5, load_15 = os.getloadavg()
        except Exception:
            pass

        uptime_seconds = 0
        try:
            with open("/proc/uptime", "r") as f:
                uptime_seconds = int(float(f.readline().split()[0]))
        except Exception:
            pass

        # 6. Sockets & Processes
        tcp_count = 0
        udp_count = 0
        try:
            for p in ["/proc/net/tcp", "/proc/net/tcp6"]:
                if os.path.exists(p):
                    with open(p, "r") as f:
                        tcp_count += max(0, len(f.readlines()) - 1)
            if os.path.exists("/proc/net/udp"):
                with open("/proc/net/udp", "r") as f:
                    udp_count += max(0, len(f.readlines()) - 1)
        except Exception:
            pass

        process_count = 0
        try:
            process_count = len([p for p in os.listdir("/proc") if p.isdigit()])
        except Exception:
            pass

        mem_total = self.static_info.get("mem_total", 0)
        mem_percent = round((mem_used / mem_total) * 100, 1) if mem_total > 0 else 0
        metrics = {
            "cpu_usage": round(cpu_usage, 1),
            "mem_used": mem_used,
            "mem_total": mem_total,
            "mem_percent": mem_percent,
            "swap_used": swap_used,
            "disk_used": disk_used_root,
            "net_rx_speed": rx_speed,
            "net_tx_speed": tx_speed,
            "net_rx_total": curr_rx,
            "net_tx_total": curr_tx,
            "load_1": round(load_1, 2),
            "load_5": round(load_5, 2),
            "load_15": round(load_15, 2),
            "uptime_seconds": uptime_seconds,
            "tcp_count": tcp_count,
            "udp_count": udp_count,
            "process_count": process_count,
            "disks": disks
        }

        return self.static_info, metrics

def main():
    cfg = load_config()
    collector = SysCollector()

    # Start ping worker thread
    ping_worker = PingWorker()
    ping_worker.server_id = cfg.get("nodeId", "")
    ping_worker.start()

    # Start streaming & AI unlock worker thread
    unlock_worker = UnlockWorker()
    unlock_worker.start()

    report_url = cfg["masterUrl"].rstrip("/") + "/api/report"
    headers = {
        "Content-Type": "application/json",
        "X-Node-ID": cfg["nodeId"],
        "X-Node-Secret": cfg["nodeSecret"],
        "User-Agent": "TanzAgent/1.1"
    }

    interval = float(cfg.get("interval", 2))
    print(f"⚡ Tanz Agent v1.1 started for [{cfg['nodeId']}] -> {report_url}")

    first_run = True
    need_info = True
    report_count = 0
    while True:
        try:
            start_t = time.time()
            static_info, metrics = collector.collect()
            metrics["pings"] = ping_worker.get_results()
            metrics["unlocks"] = unlock_worker.get_results()
            static_info["unlocks"] = unlock_worker.get_results()

            payload = {
                "id": cfg["nodeId"],
                "secret": cfg["nodeSecret"],
                "metrics": metrics
            }
            if first_run or need_info or (report_count % 10 == 0):
                payload["info"] = static_info
                first_run = False
                need_info = False

            data_bytes = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(report_url, data=data_bytes, headers=headers, method="POST")

            with urllib.request.urlopen(req, timeout=5) as resp:
                resp_data = json.loads(resp.read().decode("utf-8"))
                if resp_data.get("action") == "migrate" and resp_data.get("targetMasterUrl"):
                    new_url = resp_data["targetMasterUrl"]
                    sig = resp_data.get("sig", "")
                    ts = resp_data.get("timestamp", 0)
                    if not verify_action_signature("migrate", self.node_id, self.node_secret, new_url, ts, sig):
                        print(f"🚨 [SECURITY ALERT] Untrusted or forged 'migrate' command rejected! HMAC signature verification failed.")
                        continue
                    print(f"🚀 [Tanz Agent] Validated signed migration command! Handing over to: {new_url}")
                    self.master_url = new_url
                    try:
                        self.save_config()
                    except Exception:
                        pass
                    self.need_info = True
                    continue

                if resp_data.get("action") == "uninstall":
                    sig = resp_data.get("sig", "")
                    ts = resp_data.get("timestamp", 0)
                    if not verify_action_signature("uninstall", self.node_id, self.node_secret, "", ts, sig):
                        print(f"🚨 [SECURITY ALERT] Untrusted or forged 'uninstall' command rejected! HMAC signature verification failed.")
                        continue
                    print("🧹 [Tanz Agent] Validated signed uninstall command from master. Executing self-removal...")
                    cmd = (
                        "sleep 1 && "
                        "systemctl stop tanz-agent 2>/dev/null || true && "
                        "systemctl disable tanz-agent 2>/dev/null || true && "
                        "rm -f /etc/systemd/system/tanz-agent.service && "
                        "systemctl daemon-reload 2>/dev/null || true && "
                        "rm -rf /opt/tanz-agent && "
                        "pkill -9 -f /opt/tanz-agent/agent.py 2>/dev/null || true"
                    )
                    subprocess.Popen(["bash", "-c", cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
                    sys.exit(0)
                if resp_data.get("needInfo"):
                    need_info = True
                if "pingTargets" in resp_data or "pingIntervalSec" in resp_data:
                    targets = resp_data.get("pingTargets", [])
                    p_int = resp_data.get("pingIntervalSec")
                    ping_worker.set_config(targets, p_int)

        except Exception as e:
            # print(f"[WARN] Report failed: {e}")
            pass

        # Synchronize report loop to wall-clock boundary
        now = time.time()
        interval_sec = max(1.0, float(interval))
        next_tick = math.floor(now / interval_sec) * interval_sec + interval_sec
        time.sleep(max(0.1, next_tick - time.time()))

if __name__ == "__main__":
    main()

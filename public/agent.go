package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	NodeID     string  `json:"nodeId"`
	NodeSecret string  `json:"nodeSecret"`
	MasterURL  string  `json:"masterUrl"`
	Interval   float64 `json:"interval"`
}

type PingTarget struct {
	ID      string   `json:"id"`
	Host    string   `json:"host"`
	Clients []string `json:"clients"`
}

type MasterResponse struct {
	OK              bool         `json:"ok"`
	Timestamp       int64        `json:"timestamp"`
	Action          string       `json:"action"`
	Sig             string       `json:"sig"`
	TargetMasterUrl string       `json:"targetMasterUrl"`
	NeedInfo        bool         `json:"needInfo"`
	PingIntervalSec float64      `json:"pingIntervalSec"`
	PingTargets     []PingTarget `json:"pingTargets"`
}

func verifyActionSignature(action, nodeID, nodeSecret, targetURL string, timestamp int64, sig string) bool {
	if sig == "" || timestamp <= 0 {
		return false
	}
	now := time.Now().Unix()
	diff := now - timestamp
	if diff < -300 || diff > 300 {
		fmt.Printf("🚨 [SECURITY ALERT] Action '%s' signature expired (timestamp delta: %d s)\n", action, diff)
		return false
	}
	payload := fmt.Sprintf("%s:%s:%d:%s", action, nodeID, timestamp, targetURL)
	mac := hmac.New(sha256.New, []byte(nodeSecret))
	mac.Write([]byte(payload))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(sig), []byte(expected))
}

type DiskInfo struct {
	Mount   string  `json:"mount"`
	Device  string  `json:"device"`
	FSType  string  `json:"fstype"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
}

type StaticInfo struct {
	Hostname       string                 `json:"hostname"`
	Kernel         string                 `json:"kernel"`
	Arch           string                 `json:"arch"`
	OS             string                 `json:"os"`
	CPUModel       string                 `json:"cpu_model"`
	CPUCores       int                    `json:"cpu_cores"`
	Virtualization string                 `json:"virtualization"`
	MemTotal       uint64                 `json:"mem_total"`
	SwapTotal      uint64                 `json:"swap_total"`
	DiskTotal      uint64                 `json:"disk_total"`
	BootTime       int64                  `json:"boot_time"`
	Unlocks        map[string]interface{} `json:"unlocks"`
	Routes         map[string]string      `json:"routes"`
}

type Metrics struct {
	CPUUsage      float64                `json:"cpu_usage"`
	MemUsed       uint64                 `json:"mem_used"`
	MemTotal      uint64                 `json:"mem_total"`
	MemPercent    float64                `json:"mem_percent"`
	SwapUsed      uint64                 `json:"swap_used"`
	DiskUsed      uint64                 `json:"disk_used"`
	NetRxSpeed    uint64                 `json:"net_rx_speed"`
	NetTxSpeed    uint64                 `json:"net_tx_speed"`
	NetRxTotal    uint64                 `json:"net_rx_total"`
	NetTxTotal    uint64                 `json:"net_tx_total"`
	Load1         float64                `json:"load_1"`
	Load5         float64                `json:"load_5"`
	Load15        float64                `json:"load_15"`
	UptimeSeconds int64                  `json:"uptime_seconds"`
	TCPCount      int                    `json:"tcp_count"`
	UDPCount      int                    `json:"udp_count"`
	ProcessCount  int                    `json:"process_count"`
	Disks         []DiskInfo             `json:"disks"`
	Pings         map[string]float64     `json:"pings"`
	Unlocks       map[string]interface{} `json:"unlocks"`
	Routes        map[string]string      `json:"routes"`
}

type ReportPayload struct {
	ID      string      `json:"id"`
	Secret  string      `json:"secret"`
	Metrics Metrics     `json:"metrics"`
	Info    *StaticInfo `json:"info,omitempty"`
	Routes  map[string]string `json:"routes,omitempty"`
}

// Global Collectors & Workers
var (
	prevCPUTotal uint64
	prevCPUIdle  uint64
	prevNetRx    uint64
	prevNetTx    uint64
	prevTime     time.Time

	staticInfo StaticInfo

	pingMu      sync.RWMutex
	pingTargets []PingTarget
	pingResults = make(map[string]float64)
	pingInterval = 3.0

	unlockMu      sync.RWMutex
	routeMu      sync.RWMutex
	routeResults = map[string]string{
		"telecom": "电信 163",
		"unicom":  "联通 4837",
		"mobile":  "移动 CMI",
	}

	unlockResults = map[string]interface{}{
		"youtube": "检测中...",
		"netflix": "检测中...",
		"disney":  "检测中...",
		"chatgpt": "检测中...",
		"claude":  "检测中...",
	}
)

func initStaticInfo() {
	hostname, _ := os.Hostname()
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x86_64"
	}

	kernel := "Linux"
	if out, err := exec.Command("uname", "-r").Output(); err == nil {
		kernel = strings.TrimSpace(string(out))
	}

	osName := "Linux"
	if data, err := os.ReadFile("/etc/os-release"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				osName = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
				break
			}
		}
	}

	cpuModel := "Unknown CPU"
	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, "model name") {
				parts := strings.Split(line, ":")
				if len(parts) > 1 {
					cpuModel = strings.TrimSpace(parts[1])
					break
				}
			}
		}
	}

	virt := detectVirt()

	var memTotal, swapTotal uint64
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, _ := strconv.ParseUint(fields[1], 10, 64)
				if fields[0] == "MemTotal:" {
					memTotal = val * 1024
				} else if fields[0] == "SwapTotal:" {
					swapTotal = val * 1024
				}
			}
		}
	}

	var diskTotal uint64
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		diskTotal = stat.Blocks * uint64(stat.Bsize)
	}

	var bootTime int64
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if up, err := strconv.ParseFloat(fields[0], 64); err == nil {
				bootTime = time.Now().Unix() - int64(up)
			}
		}
	}

	staticInfo = StaticInfo{
		Hostname:       hostname,
		Kernel:         kernel,
		Arch:           arch,
		OS:             osName,
		CPUModel:       cpuModel,
		CPUCores:       runtime.NumCPU(),
		Virtualization: virt,
		MemTotal:       memTotal,
		SwapTotal:      swapTotal,
		DiskTotal:      diskTotal,
		BootTime:       bootTime,
		Unlocks:        unlockResults,
		Routes:         routeResults,
	}
}

func detectVirt() string {
	if out, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		v := strings.ToLower(strings.TrimSpace(string(out)))
		if v != "" && v != "none" {
			return v
		}
	}
	if _, err := os.Stat("/proc/vz"); err == nil {
		return "openvz"
	}
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker"
	}
	if data, err := os.ReadFile("/sys/class/dmi/id/product_name"); err == nil {
		p := strings.ToLower(string(data))
		if strings.Contains(p, "kvm") || strings.Contains(p, "qemu") {
			return "kvm"
		}
		if strings.Contains(p, "virtualbox") {
			return "vbox"
		}
		if strings.Contains(p, "vmware") {
			return "vmware"
		}
	}
	if data, err := os.ReadFile("/sys/class/dmi/id/sys_vendor"); err == nil {
		v := strings.ToLower(string(data))
		if strings.Contains(v, "qemu") || strings.Contains(v, "hetzner") || strings.Contains(v, "digitalocean") {
			return "kvm"
		}
	}
	return "kvm"
}

func readCPURaw() (total uint64, idle uint64) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)[1:]
			var sum uint64
			for i, f := range fields {
				val, _ := strconv.ParseUint(f, 10, 64)
				sum += val
				if i == 3 { // idle is the 4th field (index 3)
					idle = val
				}
			}
			return sum, idle
		}
	}
	return 0, 0
}

func readNetRaw() (rx uint64, tx uint64) {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.Contains(line, ":") {
			parts := strings.Split(line, ":")
			iface := strings.TrimSpace(parts[0])
			if iface == "lo" || strings.HasPrefix(iface, "docker") || strings.HasPrefix(iface, "veth") || strings.HasPrefix(iface, "br-") {
				continue
			}
			fields := strings.Fields(parts[1])
			if len(fields) >= 9 {
				r, _ := strconv.ParseUint(fields[0], 10, 64)
				t, _ := strconv.ParseUint(fields[8], 10, 64)
				rx += r
				tx += t
			}
		}
	}
	return rx, tx
}

func collectMetrics() Metrics {
	now := time.Now()
	dt := now.Sub(prevTime).Seconds()
	if dt < 0.5 {
		dt = 1.0
	}

	// 1. CPU
	currTotal, currIdle := readCPURaw()
	totalDelta := currTotal - prevCPUTotal
	idleDelta := currIdle - prevCPUIdle
	var cpuUsage float64
	if totalDelta > 0 {
		cpuUsage = float64(totalDelta-idleDelta) / float64(totalDelta) * 100.0
		if cpuUsage < 0 {
			cpuUsage = 0
		} else if cpuUsage > 100 {
			cpuUsage = 100
		}
	}
	prevCPUTotal = currTotal
	prevCPUIdle = currIdle

	// 2. Network
	currRx, currTx := readNetRaw()
	var rxSpeed, txSpeed uint64
	if currRx >= prevNetRx {
		rxSpeed = uint64(float64(currRx-prevNetRx) / dt)
	}
	if currTx >= prevNetTx {
		txSpeed = uint64(float64(currTx-prevNetTx) / dt)
	}
	prevNetRx = currRx
	prevNetTx = currTx
	prevTime = now

	// 3. Memory & Swap
	var memFree, buffers, cached, sreclaimable, swapFree uint64
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) >= 2 {
				val, _ := strconv.ParseUint(fields[1], 10, 64)
				val *= 1024
				switch fields[0] {
				case "MemFree:":
					memFree = val
				case "Buffers:":
					buffers = val
				case "Cached:":
					cached = val
				case "SReclaimable:":
					sreclaimable = val
				case "SwapFree:":
					swapFree = val
				}
			}
		}
	}
	memActualFree := memFree + buffers + cached + sreclaimable
	var memUsed, swapUsed uint64
	if staticInfo.MemTotal > memActualFree {
		memUsed = staticInfo.MemTotal - memActualFree
	}
	if staticInfo.SwapTotal > swapFree {
		swapUsed = staticInfo.SwapTotal - swapFree
	}

	var memPercent float64
	if staticInfo.MemTotal > 0 {
		memPercent = float64(memUsed) / float64(staticInfo.MemTotal) * 100.0
	}

	// 4. Disk
	var diskUsedRoot uint64
	var stat syscall.Statfs_t
	var disks []DiskInfo
	if err := syscall.Statfs("/", &stat); err == nil {
		totalB := stat.Blocks * uint64(stat.Bsize)
		freeB := stat.Bavail * uint64(stat.Bsize)
		if totalB >= freeB {
			diskUsedRoot = totalB - freeB
			pct := 0.0
			if totalB > 0 {
				pct = float64(diskUsedRoot) / float64(totalB) * 100.0
			}
			disks = append(disks, DiskInfo{
				Mount:   "/",
				Device:  "/dev/root",
				FSType:  "ext4",
				Total:   totalB,
				Used:    diskUsedRoot,
				Free:    freeB,
				Percent: mathRound(pct, 1),
			})
		}
	}

	// 5. Load
	var l1, l5, l15 float64
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			l1, _ = strconv.ParseFloat(fields[0], 64)
			l5, _ = strconv.ParseFloat(fields[1], 64)
			l15, _ = strconv.ParseFloat(fields[2], 64)
		}
	}

	// 6. Uptime
	var uptimeSec int64
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if up, err := strconv.ParseFloat(fields[0], 64); err == nil {
				uptimeSec = int64(up)
			}
		}
	}

	// 7. Sockets & Procs
	tcpCount := countProcNetLines("/proc/net/tcp") + countProcNetLines("/proc/net/tcp6")
	udpCount := countProcNetLines("/proc/net/udp")
	processCount := countProcesses()

	// 8. Pings
	pingsCopy := make(map[string]float64)
	pingMu.RLock()
	for k, v := range pingResults {
		pingsCopy[k] = v
	}
	pingMu.RUnlock()

	// 9. Unlocks
	unlocksCopy := make(map[string]interface{})
	unlockMu.RLock()
	for k, v := range unlockResults {
		unlocksCopy[k] = v
	}
	unlockMu.RUnlock()

		// 10. Routes (测出来什么就写什么)
	routesCopy := make(map[string]string)
	routeMu.RLock()
	for k, v := range routeResults {
		routesCopy[k] = v
	}
	routeMu.RUnlock()

	return Metrics{
		CPUUsage:      mathRound(cpuUsage, 1),
		MemUsed:       memUsed,
		MemTotal:      staticInfo.MemTotal,
		MemPercent:    mathRound(memPercent, 1),
		SwapUsed:      swapUsed,
		DiskUsed:      diskUsedRoot,
		NetRxSpeed:    rxSpeed,
		NetTxSpeed:    txSpeed,
		NetRxTotal:    currRx,
		NetTxTotal:    currTx,
		Load1:         mathRound(l1, 2),
		Load5:         mathRound(l5, 2),
		Load15:        mathRound(l15, 2),
		UptimeSeconds: uptimeSec,
		TCPCount:      tcpCount,
		UDPCount:      udpCount,
		ProcessCount:  processCount,
		Disks:         disks,
		Pings:         pingsCopy,
		Unlocks:       unlocksCopy,
		Routes:        routesCopy,
	}
}

func countProcNetLines(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) > 1 {
		return len(lines) - 1
	}
	return 0
}

func countProcesses() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if e.IsDir() {
			if _, err := strconv.Atoi(e.Name()); err == nil {
				count++
			}
		}
	}
	return count
}

func mathRound(val float64, prec int) float64 {
	pow := 1.0
	for i := 0; i < prec; i++ {
		pow *= 10
	}
	return float64(int(val*pow+0.5)) / pow
}

// Ping Worker
func startPingWorker(nodeID string) {
	timeReg := regexp.MustCompile(`time=([0-9\.]+)\s*ms`)
	for {
		pingMu.RLock()
		targets := make([]PingTarget, len(pingTargets))
		copy(targets, pingTargets)
		intervalSec := pingInterval
		pingMu.RUnlock()

		if len(targets) == 0 {
			time.Sleep(2 * time.Second)
			continue
		}

		var wg sync.WaitGroup
		sem := make(chan struct{}, 10) // max 10 concurrent pings

		for _, t := range targets {
			if t.Host == "" || t.ID == "" {
				continue
			}
			if len(t.Clients) > 0 {
				matched := false
				for _, c := range t.Clients {
					if c == nodeID {
						matched = true
						break
					}
				}
				if !matched {
					continue
				}
			}

			wg.Add(1)
			sem <- struct{}{}
			go func(tgt PingTarget) {
				defer wg.Done()
				defer func() { <-sem }()

				cleanHost := strings.Split(tgt.Host, ":")[0]
				cmd := exec.Command("ping", "-c", "1", "-W", "1", cleanHost)
				out, err := cmd.CombinedOutput()
				lat := -1.0
				if err == nil {
					match := timeReg.FindSubmatch(out)
					if len(match) > 1 {
						if l, err := strconv.ParseFloat(string(match[1]), 64); err == nil {
							lat = mathRound(l, 1)
						}
					}
				}
				pingMu.Lock()
				pingResults[tgt.ID] = lat
				pingMu.Unlock()
			}(t)
		}
		wg.Wait()

		time.Sleep(time.Duration(intervalSec * float64(time.Second)))
	}
}

// Unlock Worker

func runTraceroute(target string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "traceroute", "-m", "15", "-q", "1", "-w", "1", target)
	out, err := cmd.Output()
	if err == nil && len(out) > 0 {
		return string(out)
	}

	cmd2 := exec.CommandContext(ctx, "tracepath", "-m", "15", target)
	out2, err2 := cmd2.Output()
	if err2 == nil && len(out2) > 0 {
		return string(out2)
	}
	return ""
}

func startRouteWorker() {
	checkRoutes := func() {
		results := make(map[string]string)

		// 1. Telecom (CT) - Guangzhou Telecom: 113.108.209.1
		outCT := runTraceroute("113.108.209.1")
		if strings.Contains(outCT, "59.43.") {
			results["telecom"] = "电信 CN2 GIA"
		} else if strings.Contains(outCT, "202.97.") {
			results["telecom"] = "电信 163"
		} else if strings.Contains(outCT, "218.105.") || strings.Contains(outCT, "210.51.") {
			results["telecom"] = "电信 9929"
		} else if strings.Contains(outCT, "113.96.") || strings.Contains(outCT, "14.14.") || strings.Contains(outCT, "183.6.") {
			results["telecom"] = "电信 直连"
		} else {
			results["telecom"] = "电信 163"
		}

		// 2. Unicom (CU) - Shanghai Unicom: 210.22.80.1
		outCU := runTraceroute("210.22.80.1")
		if strings.Contains(outCU, "218.105.") || strings.Contains(outCU, "210.51.") {
			results["unicom"] = "联通 9929"
		} else if strings.Contains(outCU, "219.158.") {
			results["unicom"] = "联通 4837"
		} else if strings.Contains(outCU, "139.226.") || strings.Contains(outCU, "112.64.") {
			results["unicom"] = "联通 直连"
		} else {
			results["unicom"] = "联通 4837"
		}

		// 3. Mobile (CM) - Guangzhou Mobile: 120.196.165.24
		outCM := runTraceroute("120.196.165.24")
		if strings.Contains(outCM, "223.119.") {
			results["mobile"] = "移动 CMIN2"
		} else if strings.Contains(outCM, "223.120.") {
			results["mobile"] = "移动 CMI"
		} else if strings.Contains(outCM, "221.183.") {
			results["mobile"] = "移动 9808"
		} else if strings.Contains(outCM, "120.196.") || strings.Contains(outCM, "120.241.") {
			results["mobile"] = "移动 直连"
		} else {
			results["mobile"] = "移动 CMI"
		}

		routeMu.Lock()
		routeResults = results
		routeMu.Unlock()
	}

	go checkRoutes()
	ticker := time.NewTicker(30 * time.Minute)
	go func() {
		for range ticker.C {
			checkRoutes()
		}
	}()
}

func startUnlockWorker() {
	client := &http.Client{
		Timeout: 4 * time.Second,
	}

	checkAll := func() {
		results := make(map[string]interface{})

		// YouTube
		if resp, err := client.Get("https://www.youtube.com/premium"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				results["youtube"] = "原生支持"
			} else {
				results["youtube"] = "不可用"
			}
		} else {
			results["youtube"] = "超时"
		}

		// Netflix
		if resp, err := client.Get("https://www.netflix.com/title/80018499"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				results["netflix"] = "原生解锁"
			} else {
				results["netflix"] = "仅自制剧"
			}
		} else {
			results["netflix"] = "超时"
		}

		// Disney+
		if resp, err := client.Get("https://www.disneyplus.com"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				results["disney"] = "支持"
			} else {
				results["disney"] = "不可用"
			}
		} else {
			results["disney"] = "超时"
		}

		// ChatGPT
		if resp, err := client.Get("https://chatgpt.com"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 || resp.StatusCode == 403 {
				results["chatgpt"] = "可用"
			} else {
				results["chatgpt"] = "不可用"
			}
		} else {
			results["chatgpt"] = "超时"
		}

		// Claude
		if resp, err := client.Get("https://claude.ai"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 || resp.StatusCode == 403 {
				results["claude"] = "原生解锁"
			} else {
				results["claude"] = "不可用"
			}
		} else {
			results["claude"] = "超时"
		}

		unlockMu.Lock()
		unlockResults = results
		unlockMu.Unlock()
	}

	checkAll()
	ticker := time.NewTicker(10 * time.Minute)
	go func() {
		for range ticker.C {
			checkAll()
		}
	}()
}

func main() {
	configPathFlag := flag.String("config", "", "Path to config.json")
	nodeIDFlag := flag.String("id", "", "Node ID")
	secretFlag := flag.String("secret", "", "Node Secret")
	serverFlag := flag.String("server", "", "Master Server URL")
	flag.Parse()

	// Default paths
	execPath, _ := os.Executable()
	dir := filepath.Dir(execPath)
	configPath := filepath.Join(dir, "config.json")
	if *configPathFlag != "" {
		configPath = *configPathFlag
	}

	cfg := Config{
		NodeID:     os.Getenv("NODE_ID"),
		NodeSecret: os.Getenv("NODE_SECRET"),
		MasterURL:  os.Getenv("MASTER_URL"),
		Interval:   2.0,
	}

	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}

	if *nodeIDFlag != "" {
		cfg.NodeID = *nodeIDFlag
	}
	if *secretFlag != "" {
		cfg.NodeSecret = *secretFlag
	}
	if *serverFlag != "" {
		cfg.MasterURL = *serverFlag
	}

	if cfg.NodeID == "" {
		cfg.NodeID = "node-default"
	}
	if cfg.MasterURL == "" {
		cfg.MasterURL = "https://tanz.example.com"
	}
	cfg.MasterURL = strings.TrimRight(cfg.MasterURL, "/")

	fmt.Printf("⚡ [Tanz Binary Agent v2.0] Starting for [%s] -> %s\n", cfg.NodeID, cfg.MasterURL)

	initStaticInfo()
	prevCPUTotal, prevCPUIdle = readCPURaw()
	prevNetRx, prevNetTx = readNetRaw()
	prevTime = time.Now()

	go startPingWorker(cfg.NodeID)
	go startUnlockWorker()
	go startRouteWorker()

	httpClient := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   3 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:        5,
			IdleConnTimeout:     90 * time.Second,
			DisableCompression: false,
		},
	}

	reportURL := cfg.MasterURL + "/api/report"
	reportCount := 0
	needInfo := true

	ticker := time.NewTicker(time.Duration(cfg.Interval * float64(time.Second)))
	defer ticker.Stop()

	for range ticker.C {
		reportCount++
		metrics := collectMetrics()

		payload := ReportPayload{
			ID:      cfg.NodeID,
			Secret:  cfg.NodeSecret,
			Metrics: metrics,
		}

		if needInfo || reportCount%10 == 1 {
			unlockMu.RLock()
			staticInfo.Unlocks = unlockResults
			unlockMu.RUnlock()
			infoCopy := staticInfo
			payload.Info = &infoCopy
			needInfo = false
		}

		bodyBytes, err := json.Marshal(payload)
		if err != nil {
			continue
		}

		req, err := http.NewRequest("POST", reportURL, bytes.NewReader(bodyBytes))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Node-ID", cfg.NodeID)
		req.Header.Set("X-Node-Secret", cfg.NodeSecret)
		req.Header.Set("User-Agent", "TanzBinaryAgent/2.0 (Zero-GC MicroCore)")

		resp, err := httpClient.Do(req)
		if err != nil {
			fmt.Printf("[WARN] Report failed: %v\n", err)
			continue
		}

		respBytes, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			continue
		}

		var mResp MasterResponse
		if err := json.Unmarshal(respBytes, &mResp); err == nil {
			if mResp.Action == "migrate" && mResp.TargetMasterUrl != "" {
				if !verifyActionSignature(mResp.Action, cfg.NodeID, cfg.NodeSecret, mResp.TargetMasterUrl, mResp.Timestamp, mResp.Sig) {
					fmt.Printf("🚨 [SECURITY ALERT] Untrusted or forged 'migrate' command rejected! HMAC signature verification failed.\n")
					continue
				}
				fmt.Printf("🚀 [Tanz Agent] Validated signed master migration command! Handing over to: %s\n", mResp.TargetMasterUrl)
				cfg.MasterURL = mResp.TargetMasterUrl
				if cfgData, err := json.MarshalIndent(cfg, "", "  "); err == nil {
					_ = os.WriteFile("/opt/tanz-agent/config.json", cfgData, 0644)
				}
				reportURL = strings.TrimRight(cfg.MasterURL, "/") + "/api/report"
				needInfo = true
				continue
			}
			if mResp.Action == "uninstall" {
				if !verifyActionSignature(mResp.Action, cfg.NodeID, cfg.NodeSecret, "", mResp.Timestamp, mResp.Sig) {
					fmt.Printf("🚨 [SECURITY ALERT] Untrusted or forged 'uninstall' command rejected! HMAC signature verification failed.\n")
					continue
				}
				fmt.Println("🧹 [Tanz Agent] Validated signed uninstall command from master. Executing self-removal...")
				cmd := "sleep 1 && systemctl stop tanz-agent 2>/dev/null || true && systemctl disable tanz-agent 2>/dev/null || true && rm -f /etc/systemd/system/tanz-agent.service && systemctl daemon-reload 2>/dev/null || true && rm -rf /opt/tanz-agent && pkill -9 -f tanz-agent 2>/dev/null || true"
				_ = exec.Command("bash", "-c", cmd).Start()
				os.Exit(0)
			}
			if mResp.NeedInfo {
				needInfo = true
			}
			if len(mResp.PingTargets) > 0 {
				pingMu.Lock()
				pingTargets = mResp.PingTargets
				if mResp.PingIntervalSec >= 1.0 {
					pingInterval = mResp.PingIntervalSec
				}
				pingMu.Unlock()
			}
		}
	}
}

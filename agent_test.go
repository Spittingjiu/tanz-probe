package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExtractPingHost(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"1.1.1.1", "1.1.1.1"},
		{" 8.8.8.8:53 ", "8.8.8.8"},
		{"[2400:3200::1]", "2400:3200::1"},
		{"[2400:3200::1]:443", "2400:3200::1"},
		{"2400:3200::1", "2400:3200::1"},
		{"example.com:80", "example.com"},
	}
	for _, c := range cases {
		if got := extractPingHost(c.in); got != c.want {
			t.Errorf("extractPingHost(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestClassifyRoutes(t *testing.T) {
	if got := classifyTelecomRoute(""); got != "未知" {
		t.Fatalf("empty telecom = %q", got)
	}
	if got := classifyTelecomRoute("hop 5 59.43.1.1"); got != "电信 CN2 GIA" {
		t.Fatalf("cn2 gia = %q", got)
	}
	if got := classifyTelecomRoute("hop 3 202.97.1.1\nhop 5 59.43.1.1"); got != "电信 CN2 GT" {
		t.Fatalf("cn2 gt = %q", got)
	}
	if got := classifyUnicomRoute(""); got != "未知" {
		t.Fatalf("empty unicom = %q", got)
	}
	if got := classifyUnicomRoute("hop 4 218.105.1.1"); got != "联通 9929" {
		t.Fatalf("unicom 9929 = %q", got)
	}
	if got := classifyMobileRoute(""); got != "未知" {
		t.Fatalf("empty mobile = %q", got)
	}
	if got := classifyMobileRoute("hop 4 223.119.1.1"); got != "移动 CMIN2" {
		t.Fatalf("mobile cmin2 = %q", got)
	}
}

func TestEvaluateUnlockStatus(t *testing.T) {
	if got := evaluateUnlockStatus("chatgpt", 403, "cf challenge", "https://chatgpt.com"); got != "限制访问" {
		t.Errorf("chatgpt 403 = %q, want 限制访问", got)
	}
	if got := evaluateUnlockStatus("chatgpt", 200, "<html>ChatGPT</html>", "https://chatgpt.com"); got != "可用" {
		t.Errorf("chatgpt 200 = %q, want 可用", got)
	}
	if got := evaluateUnlockStatus("claude", 403, "blocked", "https://claude.ai"); got != "限制访问" {
		t.Errorf("claude 403 = %q, want 限制访问", got)
	}
	if got := evaluateUnlockStatus("claude", 200, "app-unavailable", "https://claude.ai"); got != "不可用" {
		t.Errorf("claude unavailable = %q, want 不可用", got)
	}
	if got := evaluateUnlockStatus("netflix", 403, "", ""); got != "仅自制剧" {
		t.Errorf("netflix 403 = %q, want 仅自制剧", got)
	}
}

func TestProbeUnlockURLWithMockServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/blocked" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("blocked"))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	c := &http.Client{Timeout: 2 * time.Second}
	code, _, _, err := probeUnlockURL(c, srv.URL+"/blocked")
	if err != nil {
		t.Fatalf("probeUnlockURL failed: %v", err)
	}
	if got := evaluateUnlockStatus("claude", code, "", ""); got != "限制访问" {
		t.Errorf("got %q, want 限制访问", got)
	}
}

func TestVerifyActionSignatureAndBinaryHeaders(t *testing.T) {
	ts := time.Now().Unix()
	secret := "sec_test_123"
	payload := fmt.Sprintf("update:node-la:%d:", ts)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))

	if !verifyActionSignature("update", "node-la", secret, "", ts, sig) {
		t.Fatal("valid signature failed verification")
	}
	if verifyActionSignature("update", "node-la", secret, "", ts-400, sig) {
		t.Fatal("expired timestamp should fail")
	}
	if resolveAgentBinaryName("linux", "amd64") != "tanz-agent-linux-amd64" {
		t.Fatal("unexpected binary name")
	}
	if !isValidExecutableHeader("linux", []byte{0x7F, 'E', 'L', 'F'}) {
		t.Fatal("ELF header rejected")
	}
	if isValidExecutableHeader("linux", []byte("<html>404</html>")) {
		t.Fatal("HTML should not pass binary header check")
	}
}

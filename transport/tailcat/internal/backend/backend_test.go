package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"tailscale.com/tailcfg"
	"testing"
	"time"
)

func TestPrivateDERPRequired(t *testing.T) {
	for _, r := range []*tailcfg.DERPRegion{nil, {}, {RegionID: 901}} {
		if ValidateRegion(r) == nil {
			t.Fatal("missing DERP accepted")
		}
	}
	r := &tailcfg.DERPRegion{RegionID: 901, Nodes: []*tailcfg.DERPNode{{Name: "test", RegionID: 901, HostName: "relay.example.com"}}}
	if ValidateRegion(r) != nil {
		t.Fatal("valid region rejected")
	}
	r.Nodes[0].InsecureForTests = true
	if ValidateRegion(r) == nil {
		t.Fatal("insecure remote accepted")
	}
	r.Nodes[0].HostName = "127.0.0.1"
	if ValidateRegion(r) != nil {
		t.Fatal("loopback fixture rejected")
	}
	r.Nodes[0].IPv4 = "192.0.2.1"
	if ValidateRegion(r) == nil {
		t.Fatal("remote insecure address bypass")
	}
}
func TestPrepareDoesNotStartNetwork(t *testing.T) {
	b := New()
	defer b.Close()
	if b.PublicKey() == "" || b.server != nil || len(b.clients) != 0 {
		t.Fatal("prepare started network")
	}
	if b.Allow(b.PublicKey()) == nil {
		t.Fatal("admission before server start accepted")
	}
}

func TestPerDeviceIdentityBeforeNetworking(t *testing.T) {
	b := New()
	defer b.Close()
	a, err := b.Prepare("device-a")
	if err != nil {
		t.Fatal(err)
	}
	c, err := b.Prepare("device-b")
	if err != nil || a == c || a == b.PublicKey() {
		t.Fatal("independent backends share DERP identity")
	}
	if len(b.clients) != 0 {
		t.Fatal("prepare started backend")
	}
	b.Drop("device-a")
	next, err := b.Prepare("device-a")
	if err != nil || next == a {
		t.Fatal("drop retained device identity")
	}
}

func TestRegionHealthUsesPinnedStockProbeAndDoesNotCreateNodes(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/derp/probe" {
			t.Errorf("unexpected probe route %s", r.URL.Path)
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer server.Close()
	sum := sha256.Sum256(server.Certificate().Raw)
	port := server.Listener.Addr().(*net.TCPAddr).Port
	b := New()
	defer b.Close()
	b.region = &tailcfg.DERPRegion{RegionID: 901, Nodes: []*tailcfg.DERPNode{{Name: "test", RegionID: 901, HostName: "fixture.invalid", IPv4: "127.0.0.1", IPv6: "none", DERPPort: port, CertName: "sha256-raw:" + hex.EncodeToString(sum[:])}}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if !b.Health(ctx) {
		t.Fatal("trusted pinned probe rejected")
	}
	status.Store(http.StatusServiceUnavailable)
	if b.Health(ctx) {
		t.Fatal("unhealthy region accepted")
	}
	b.region.Nodes[0].CertName = "sha256-raw:" + strings.Repeat("0", 64)
	if b.Health(ctx) {
		t.Fatal("wrong certificate pin accepted")
	}
	if b.server != nil || len(b.clients) != 0 || len(b.keys) != 0 {
		t.Fatal("health probe created network identity")
	}
}

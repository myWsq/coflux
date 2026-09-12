// Package backend is the sole dependency boundary to the pinned Tailcat library.
package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"
)

const Port uint16 = 43927
const MaxDevices = 16

var errConfig = errors.New("invalid private DERP configuration")

type Path struct {
	Endpoint string  `json:"endpoint,omitempty"`
	Mode     string  `json:"mode"`
	Region   int64   `json:"backendRegion,omitempty"`
	Latency  float64 `json:"latencyMs,omitempty"`
}

type Backend struct {
	mu        sync.Mutex
	key       key.NodePrivate
	server    *tailcat.Server
	region    *tailcfg.DERPRegion
	clients   map[string]*tailcat.Client
	keys      map[string]key.NodePrivate
	starting  bool
	addresses map[string]string
	allowed   map[key.NodePublic]bool
	closed    bool
}

func New() *Backend {
	return &Backend{key: key.NewNode(), clients: map[string]*tailcat.Client{}, keys: map[string]key.NodePrivate{}, addresses: map[string]string{}, allowed: map[key.NodePublic]bool{}}
}
func (b *Backend) Prepare(id string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || id == "" || len(id) > 255 {
		return "", errors.New("invalid device connection")
	}
	if k, ok := b.keys[id]; ok {
		return k.Public().String(), nil
	}
	if len(b.keys) >= MaxDevices {
		return "", errors.New("device limit reached")
	}
	k := key.NewNode()
	b.keys[id] = k
	return k.Public().String(), nil
}
func (b *Backend) PublicKey() string { return b.key.Public().String() }
func silent(string, ...any)          {}

// Embedded regions are mandatory on both sides. No public map URL is used.
func ValidateRegion(r *tailcfg.DERPRegion) error {
	if r == nil || r.RegionID <= 0 || r.RegionID.Int64() > 9007199254740991 || len(r.Nodes) == 0 || len(r.Nodes) > 8 {
		return errConfig
	}
	hasDERP := false
	for _, n := range r.Nodes {
		if n == nil || n.RegionID != r.RegionID || n.Name == "" || len(n.Name) > 255 || n.HostName == "" || len(n.HostName) > 253 || strings.ContainsAny(n.HostName, " /\\\r\n\t") || n.DERPPort < 0 || n.DERPPort > 65535 || n.STUNPort < -1 || n.STUNPort > 65535 {
			return errConfig
		}
		if n.InsecureForTests {
			ip := net.ParseIP(n.HostName)
			if ip == nil || !ip.IsLoopback() {
				return errConfig
			}
			for _, v := range []string{n.IPv4, n.IPv6, n.STUNTestIP} {
				if v != "" && v != "none" {
					ip := net.ParseIP(v)
					if ip == nil || !ip.IsLoopback() {
						return errConfig
					}
				}
			}
		}
		if !n.STUNOnly {
			hasDERP = true
		}
	}
	if !hasDERP {
		return errConfig
	}
	return nil
}

func (b *Backend) Serve(raw json.RawMessage, accept func(net.Conn)) (string, error) {
	var region tailcfg.DERPRegion
	if len(raw) > 32768 || json.Unmarshal(raw, &region) != nil || ValidateRegion(&region) != nil {
		return "", errConfig
	}
	b.mu.Lock()
	if b.closed || b.server != nil || b.starting {
		b.mu.Unlock()
		return "", errors.New("server already started or closed")
	}
	b.starting = true
	b.mu.Unlock()
	s := &tailcat.Server{Key: b.key, Region: &region, Logf: silent, AllowedClients: []key.NodePublic{b.key.Public()}, ServedTCPPorts: []filter.PortRange{{First: Port, Last: Port}}, ServedUDPPorts: []filter.PortRange{}}
	s.OnTCP = func(port uint16) func(net.Conn) {
		if port == Port {
			return accept
		}
		return nil
	}
	err := s.Start()
	b.mu.Lock()
	b.starting = false
	if err != nil {
		b.mu.Unlock()
		return "", errors.New("transport server startup failed")
	}
	if b.closed {
		b.mu.Unlock()
		s.Close()
		return "", errors.New("transport closed")
	}
	b.server = s
	b.region = &region
	b.mu.Unlock()
	return string(s.TailcatAddr()), nil
}

func (b *Backend) Allow(public string) error {
	var k key.NodePublic
	if k.UnmarshalText([]byte(public)) != nil || k.IsZero() {
		return errors.New("invalid node public key")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.server == nil {
		return errors.New("server unavailable")
	}
	if b.allowed[k] {
		return nil
	}
	if len(b.allowed) >= 256 {
		return errors.New("node limit reached")
	}
	b.allowed[k] = true
	b.server.AddAllowedClient(k)
	return nil
}

func (b *Backend) client(id, address string) (*tailcat.Client, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, errors.New("transport closed")
	}
	if c := b.clients[id]; c != nil {
		if b.addresses[id] != address {
			return nil, errors.New("connection address changed")
		}
		return c, nil
	}
	if len(b.clients) >= MaxDevices || len(address) > 32768 {
		return nil, errors.New("device limit or invalid address")
	}
	ci, err := tailcat.ParseAddr(tailcat.Addr(address))
	if err != nil || len(ci.Region) != 1 || ValidateRegion(ci.Region[0]) != nil || ci.PresharedKey == (tailcat.PresharedKey{}) {
		return nil, errConfig
	}
	k, prepared := b.keys[id]
	if !prepared {
		return nil, errors.New("device identity not prepared")
	}
	c := &tailcat.Client{Server: tailcat.Addr(address), Key: k, Logf: silent}
	b.clients[id] = c
	b.addresses[id] = address
	return c, nil
}

func (b *Backend) Dial(ctx context.Context, id, address string) (net.Conn, error) {
	c, err := b.client(id, address)
	if err != nil {
		return nil, err
	}
	conn, err := c.DialTCPPort(ctx, Port)
	if err != nil {
		return nil, errors.New("transport dial failed")
	}
	return conn, nil
}
func (b *Backend) Probe(ctx context.Context, id string) (Path, error) {
	b.mu.Lock()
	c := b.clients[id]
	b.mu.Unlock()
	if c == nil {
		return Path{}, errors.New("unknown device connection")
	}
	r, err := c.DiscoPing(ctx)
	if err != nil {
		return Path{Mode: "unknown"}, errors.New("path probe failed")
	}
	p := Path{Mode: "unknown", Latency: r.LatencySeconds * 1000}
	if r.Endpoint != "" {
		p.Mode = "direct"
		p.Endpoint = r.Endpoint
	} else if r.DERPRegionID != 0 {
		p.Mode = "relay"
		p.Region = r.DERPRegionID.Int64()
	}
	return p, nil
}

// Health checks only the configured region's stock DERP probe endpoint. It
// creates no node identity or DERP session and cannot displace the serving key.
func (b *Backend) Health(ctx context.Context) bool {
	b.mu.Lock()
	region := b.region
	closed := b.closed
	b.mu.Unlock()
	if closed || region == nil {
		return false
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan bool, len(region.Nodes))
	count := 0
	for _, node := range region.Nodes {
		if node.STUNOnly {
			continue
		}
		count++
		go func(n *tailcfg.DERPNode) {
			port := n.DERPPort
			if port == 0 {
				port = 443
			}
			config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: n.HostName, InsecureSkipVerify: n.InsecureForTests}
			if strings.HasPrefix(n.CertName, "sha256-raw:") {
				pin, err := hex.DecodeString(strings.TrimPrefix(n.CertName, "sha256-raw:"))
				if err != nil || len(pin) != sha256.Size {
					result <- false
					return
				}
				config.InsecureSkipVerify = true
				config.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
					if len(raw) == 0 {
						return errConfig
					}
					sum := sha256.Sum256(raw[0])
					if !bytes.Equal(sum[:], pin) {
						return errConfig
					}
					return nil
				}
			} else if n.CertName != "" {
				config.ServerName = n.CertName
			}
			transport := &http.Transport{TLSClientConfig: config, DisableKeepAlives: true,
				DialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
					for _, candidate := range []struct{ network, hint string }{{"tcp4", n.IPv4}, {"tcp6", n.IPv6}} {
						if candidate.hint == "none" {
							continue
						}
						host := candidate.hint
						if host == "" {
							host = n.HostName
						}
						attempt, stop := context.WithTimeout(dialCtx, time.Second)
						conn, err := (&net.Dialer{}).DialContext(attempt, candidate.network, net.JoinHostPort(host, strconv.Itoa(port)))
						stop()
						if err == nil {
							return conn, nil
						}
					}
					return nil, errors.New("region dial failed")
				},
			}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			request, err := http.NewRequestWithContext(ctx, "GET", "https://"+net.JoinHostPort(n.HostName, strconv.Itoa(port))+"/derp/probe", nil)
			if err != nil {
				result <- false
				return
			}
			response, err := client.Do(request)
			if err != nil {
				result <- false
				return
			}
			response.Body.Close()
			result <- response.StatusCode == http.StatusOK
		}(node)
	}
	for range count {
		select {
		case good := <-result:
			if good {
				return true
			}
		case <-ctx.Done():
			return false
		}
	}
	return false
}

func (b *Backend) Drop(id string) {
	b.mu.Lock()
	c := b.clients[id]
	delete(b.clients, id)
	delete(b.addresses, id)
	delete(b.keys, id)
	b.mu.Unlock()
	if c != nil {
		c.Close()
	}
}
func (b *Backend) Close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	s := b.server
	clients := b.clients
	b.clients = map[string]*tailcat.Client{}
	b.addresses = map[string]string{}
	b.keys = map[string]key.NodePrivate{}
	b.mu.Unlock()
	if s != nil {
		s.Close()
	}
	for _, c := range clients {
		c.Close()
	}
}

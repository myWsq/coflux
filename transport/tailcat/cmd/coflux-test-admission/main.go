package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"tailscale.com/derp"
	"tailscale.com/derp/derphttp"
	"tailscale.com/net/netmon"
	"tailscale.com/types/key"
	"time"
)

func main() {
	private := key.NewNode()
	fmt.Println(private.Public().String())
	if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
		panic(err)
	}
	pem, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		panic("invalid test certificate")
	}
	c, err := derphttp.NewClient(private, os.Args[1], func(string, ...any) {}, netmon.NewStatic())
	if err != nil {
		panic(err)
	}
	defer c.Close()
	c.TLSConfig = &tls.Config{RootCAs: roots}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan bool, 1)
	go func() {
		if c.Connect(ctx) != nil {
			done <- false
			return
		}
		message, err := c.Recv()
		_, ok := message.(derp.ServerInfoMessage)
		done <- err == nil && ok
	}()
	select {
	case ok := <-done:
		fmt.Println(ok)
	case <-ctx.Done():
		c.Close()
		fmt.Println(false)
	}
}

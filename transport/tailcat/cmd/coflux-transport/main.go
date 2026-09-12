package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/myWsq/coflux/transport/tailcat/internal/backend"
	"github.com/myWsq/coflux/transport/tailcat/internal/helper"
)

var releaseVersion = "dev"

func main() {
	helper.ReleaseVersion = releaseVersion
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("coflux-transport %s protocol=1\n", releaseVersion)
		return
	}
	// This executable only speaks private IPC; arguments are never interpreted as
	// addresses, credentials, shell commands, or arbitrary proxy destinations.
	if len(os.Args) != 1 {
		os.Exit(2)
	}
	// os.Stdin/Stdout are initialized before the owner pipe flags are known.
	// Rewrap explicitly nonblocking descriptors so Go's poller can interrupt a
	// blocked read/write on Close; ordinary blocking inherited FDs can outlive a
	// cancelled context even when an io.Pipe unit test passes.
	inFD, outFD := int(os.Stdin.Fd()), int(os.Stdout.Fd())
	if syscall.SetNonblock(inFD, true) != nil || syscall.SetNonblock(outFD, true) != nil {
		os.Exit(1)
	}
	in := os.NewFile(uintptr(inFD), "transport-owner-input")
	out := os.NewFile(uintptr(outFD), "transport-owner-output")
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if helper.Run(ctx, in, out, backend.New()) != nil {
		os.Exit(1)
	}
}

package helper

import (
	"context"
	"encoding/json"
	"github.com/myWsq/coflux/transport/tailcat/internal/backend"
	"github.com/myWsq/coflux/transport/tailcat/internal/ipc"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

type fakeDriver struct {
	closed chan struct{}
	once   sync.Once
}

func (f *fakeDriver) Prepare(string) (string, error) { return "public-test-client-key", nil }
func (f *fakeDriver) PublicKey() string              { return "public-test-key" }
func (f *fakeDriver) Serve(json.RawMessage, func(net.Conn)) (string, error) {
	return "private-test-address", nil
}
func (f *fakeDriver) Allow(string) error { return nil }
func (f *fakeDriver) Dial(ctx context.Context, _, _ string) (net.Conn, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (f *fakeDriver) Probe(context.Context, string) (backend.Path, error) {
	return backend.Path{Mode: "unknown"}, nil
}
func (f *fakeDriver) Health(context.Context) bool { return true }
func (f *fakeDriver) Drop(string)                 {}
func (f *fakeDriver) Close()                      { f.once.Do(func() { close(f.closed) }) }

func TestOwnerEOFClosesDriver(t *testing.T) {
	in, owner := io.Pipe()
	reader, out := io.Pipe()
	defer reader.Close()
	driver := &fakeDriver{closed: make(chan struct{})}
	result := make(chan error, 1)
	go func() { result <- Run(context.Background(), in, out, driver) }()
	p, _ := json.Marshal(Command{ID: 1, Op: "hello", Version: ipc.Version})
	if err := ipc.Write(owner, ipc.Frame{Kind: ipc.Control, Payload: p}); err != nil {
		t.Fatal(err)
	}
	f, err := ipc.Read(reader)
	if err != nil {
		t.Fatal(err)
	}
	var event Event
	if json.Unmarshal(f.Payload, &event) != nil || event.PublicKey != "public-test-key" {
		t.Fatal("missing prepared identity")
	}
	owner.Close()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("owner loss did not terminate")
	}
	select {
	case <-driver.closed:
	default:
		t.Fatal("network stack survived owner")
	}
}
func TestRejectVersionBeforeDriverUse(t *testing.T) {
	in, owner := io.Pipe()
	reader, out := io.Pipe()
	defer reader.Close()
	defer owner.Close()
	driver := &fakeDriver{closed: make(chan struct{})}
	result := make(chan error, 1)
	go func() { result <- Run(context.Background(), in, out, driver) }()
	p, _ := json.Marshal(Command{ID: 1, Op: "hello", Version: 999})
	ipc.Write(owner, ipc.Frame{Kind: ipc.Control, Payload: p})
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("version mismatch accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("version rejection hung")
	}
}

func TestStaleStreamCompletionCannotCloseReplacement(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := ipc.NewBudget(ipc.GlobalBytes)
	old := &stream{queue: ipc.NewQueue(b, ipc.QueueBytes), cancel: func() {}}
	replacement := &stream{queue: ipc.NewQueue(b, ipc.QueueBytes), cancel: func() {}}
	e := &engine{ctx: ctx, cancel: cancel, streams: map[uint32]*stream{7: replacement}, budget: b, out: ipc.NewQueue(b, ipc.GlobalBytes)}
	e.closeStreamIf(7, old)
	if e.streams[7] != replacement {
		t.Fatal("stale completion closed a replacement stream")
	}
	e.closeStreamIf(7, replacement)
	if e.streams[7] != nil {
		t.Fatal("current completion did not close its stream")
	}
	e.out.Close()
}

func TestCloseBeforeDialDispatchCannotResurrectStream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	budget := ipc.NewBudget(ipc.GlobalBytes)
	driver := &fakeDriver{closed: make(chan struct{})}
	e := &engine{ctx: ctx, cancel: cancel, driver: driver, streams: map[uint32]*stream{}, budget: budget, out: ipc.NewQueue(budget, ipc.GlobalBytes)}
	defer e.out.Close()
	command := Command{ID: 2, Op: "open", Stream: 1, Connection: "device", Address: "secret"}
	var err error
	command.pending, err = e.reserve(command)
	if err != nil {
		t.Fatal(err)
	}
	e.closeStream(1)
	done := make(chan struct{})
	go func() { e.command(command); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closed pending dial did not cancel")
	}
	if len(e.streams) != 0 {
		t.Fatal("stream resurrected after close")
	}
	var opened bool
	for {
		frame, ok := e.out.Pop()
		if !ok {
			break
		}
		var event Event
		json.Unmarshal(frame.Payload, &event)
		if event.ID == 2 && event.OK {
			opened = true
		}
		e.out.Done(frame)
	}
	if opened {
		t.Fatal("cancelled open reported success")
	}
}

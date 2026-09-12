// Package helper multiplexes bounded streams over inherited owner pipes.
package helper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/myWsq/coflux/transport/tailcat/internal/backend"
	"github.com/myWsq/coflux/transport/tailcat/internal/ipc"
)

type Driver interface {
	PublicKey() string
	Prepare(string) (string, error)
	Serve(json.RawMessage, func(net.Conn)) (string, error)
	Allow(string) error
	Dial(context.Context, string, string) (net.Conn, error)
	Probe(context.Context, string) (backend.Path, error)
	Health(context.Context) bool
	Drop(string)
	Close()
}

type Command struct {
	pending    *stream
	ID         uint32          `json:"id"`
	Op         string          `json:"op"`
	Version    int             `json:"version,omitempty"`
	Stream     uint32          `json:"stream,omitempty"`
	Connection string          `json:"connection,omitempty"`
	Address    string          `json:"address,omitempty"`
	PublicKey  string          `json:"publicKey,omitempty"`
	Region     json.RawMessage `json:"region,omitempty"`
}

// ReleaseVersion is injected by the signed build entry point.
var ReleaseVersion = "dev"

type Event struct {
	ReleaseVersion string        `json:"releaseVersion,omitempty"`
	ID             uint32        `json:"id,omitempty"`
	Op             string        `json:"op"`
	OK             bool          `json:"ok,omitempty"`
	Version        int           `json:"version,omitempty"`
	Stream         uint32        `json:"stream,omitempty"`
	PublicKey      string        `json:"publicKey,omitempty"`
	Address        string        `json:"address,omitempty"`
	Error          string        `json:"error,omitempty"`
	Path           *backend.Path `json:"path,omitempty"`
}

type stream struct {
	conn       net.Conn
	queue      *ipc.Queue
	connection string
	ctx        context.Context
	cancel     context.CancelFunc
	timer      *time.Timer
}
type engine struct {
	ctx     context.Context
	cancel  context.CancelFunc
	driver  Driver
	mu      sync.Mutex
	streams map[uint32]*stream
	next    uint32
	budget  *ipc.Budget
	out     *ipc.Queue
	work    chan struct{}
	wg      sync.WaitGroup
}

// Run takes ownership of the inherited pipes. Owner EOF, malformed IPC, a
// stalled output pipe, or cancellation closes every stream and networking stack.
func Run(ctx context.Context, in io.ReadCloser, out io.WriteCloser, driver Driver) error {
	ctx, cancel := context.WithCancel(ctx)
	e := &engine{ctx: ctx, cancel: cancel, driver: driver, streams: map[uint32]*stream{}, next: 0x80000000, budget: ipc.NewBudget(ipc.GlobalBytes), work: make(chan struct{}, 32)}
	e.out = ipc.NewQueue(e.budget, ipc.GlobalBytes)
	defer func() {
		cancel()
		in.Close()
		out.Close()
		e.mu.Lock()
		ids := make([]uint32, 0, len(e.streams))
		for id := range e.streams {
			ids = append(ids, id)
		}
		e.mu.Unlock()
		for _, id := range ids {
			e.closeStream(id)
		}
		e.out.Close()
		driver.Close()
		e.wg.Wait()
	}()
	go func() { <-ctx.Done(); in.Close(); out.Close() }()
	handshakeTimer := time.AfterFunc(5*time.Second, cancel)
	defer handshakeTimer.Stop()
	first, err := ipc.Read(in)
	if err != nil {
		return err
	}
	var hello Command
	if first.Kind != ipc.Control || json.Unmarshal(first.Payload, &hello) != nil || hello.Op != "hello" || hello.Version != ipc.Version || hello.ID == 0 {
		return errors.New("incompatible transport IPC")
	}
	if err := writeEvent(out, Event{ID: hello.ID, Op: "hello", OK: true, Version: ipc.Version, ReleaseVersion: ReleaseVersion, PublicKey: driver.PublicKey()}); err != nil {
		return err
	}
	handshakeTimer.Stop()
	go e.writeOutput(out)
	for {
		f, err := ipc.ReadBudget(in, e.budget)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if f.Kind == ipc.Data {
			e.mu.Lock()
			s := e.streams[f.Stream]
			e.mu.Unlock()
			if s == nil || s.queue.Push(f) != nil {
				ipc.Release(f)
				e.closeStreamIf(f.Stream, s)
			}
			continue
		}
		var cmd Command
		err = json.Unmarshal(f.Payload, &cmd)
		ipc.Release(f)
		if err != nil || cmd.ID == 0 {
			return ipc.ErrFrame
		}
		if cmd.Op == "shutdown" {
			return nil
		}
		if cmd.Op == "close" {
			e.closeStream(cmd.Stream)
			e.reply(cmd, nil)
			continue
		}
		if cmd.Op == "open" {
			var reserveErr error
			cmd.pending, reserveErr = e.reserve(cmd)
			if reserveErr != nil {
				e.reply(cmd, reserveErr)
				continue
			}
		}
		select {
		case e.work <- struct{}{}:
			e.wg.Add(1)
			go func() { defer e.wg.Done(); defer func() { <-e.work }(); e.command(cmd) }()
		default:
			if cmd.pending != nil {
				e.closeStreamIf(cmd.Stream, cmd.pending)
			}
			e.emit(Event{ID: cmd.ID, Op: cmd.Op, Error: "busy"})
		}
	}
}

func writeEvent(w io.Writer, event Event) error {
	p, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return ipc.Write(w, ipc.Frame{Kind: ipc.Control, Payload: p})
}
func (e *engine) emit(event Event) {
	p, err := json.Marshal(event)
	if err != nil || len(p) > ipc.MaxControl || e.out.Push(ipc.Frame{Kind: ipc.Control, Payload: p}) != nil {
		e.cancel()
	}
}
func (e *engine) reply(cmd Command, err error) {
	event := Event{ID: cmd.ID, Op: cmd.Op, OK: err == nil, Stream: cmd.Stream}
	if err != nil {
		event.Error = "transport operation rejected"
	}
	e.emit(event)
}
func (e *engine) writeOutput(w io.WriteCloser) {
	for {
		for {
			f, ok := e.out.Pop()
			if !ok {
				break
			}
			timer := time.AfterFunc(20*time.Second, func() { e.cancel(); w.Close() })
			err := ipc.Write(w, f)
			e.out.Done(f)
			timer.Stop()
			if err != nil {
				e.cancel()
				return
			}
		}
		select {
		case <-e.ctx.Done():
			return
		case <-e.out.Wake():
		}
	}
}
func validID(id string) bool {
	if len(id) == 0 || len(id) > 255 {
		return false
	}
	for _, c := range id {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

func (e *engine) reserve(cmd Command) (*stream, error) {
	if cmd.Stream == 0 || cmd.Stream >= 0x80000000 || !validID(cmd.Connection) {
		return nil, ipc.ErrFrame
	}
	ctx, cancel := context.WithTimeout(e.ctx, 15*time.Second)
	s := &stream{queue: ipc.NewQueue(e.budget, ipc.QueueBytes), connection: cmd.Connection, cancel: cancel, ctx: ctx}
	e.mu.Lock()
	if len(e.streams) >= ipc.MaxStreams || e.streams[cmd.Stream] != nil {
		e.mu.Unlock()
		cancel()
		return nil, ipc.ErrFull
	}
	e.streams[cmd.Stream] = s
	e.mu.Unlock()
	return s, nil
}

func (e *engine) command(cmd Command) {
	if e.ctx.Err() != nil {
		return
	}
	switch cmd.Op {
	case "prepare":
		if !validID(cmd.Connection) {
			e.reply(cmd, ipc.ErrFrame)
			return
		}
		public, err := e.driver.Prepare(cmd.Connection)
		if err != nil {
			e.reply(cmd, err)
		} else {
			e.emit(Event{ID: cmd.ID, Op: cmd.Op, OK: true, PublicKey: public})
		}
	case "serve":
		address, err := e.driver.Serve(cmd.Region, e.accept)
		if err != nil {
			e.reply(cmd, err)
		} else {
			e.emit(Event{ID: cmd.ID, Op: cmd.Op, OK: true, Address: address})
		}
	case "allow":
		e.reply(cmd, e.driver.Allow(cmd.PublicKey))
	case "open":
		s := cmd.pending
		if s == nil {
			e.reply(cmd, ipc.ErrFrame)
			return
		}
		conn, err := e.driver.Dial(s.ctx, cmd.Connection, cmd.Address)
		s.cancel()
		e.mu.Lock()
		current := e.streams[cmd.Stream] == s && e.ctx.Err() == nil
		if err == nil && current {
			s.conn = conn
		}
		e.mu.Unlock()
		if err != nil || !current {
			if conn != nil {
				conn.Close()
			}
			e.closeStreamIf(cmd.Stream, s)
			e.reply(cmd, errors.New("dial failed"))
			return
		}
		e.reply(cmd, nil)
		e.pump(cmd.Stream, s)
	case "authorize":
		e.mu.Lock()
		s := e.streams[cmd.Stream]
		if s != nil && s.timer != nil {
			s.timer.Stop()
			s.timer = nil
		}
		e.mu.Unlock()
		if s == nil {
			e.reply(cmd, ipc.ErrFrame)
		} else {
			e.reply(cmd, nil)
		}
	case "drop":
		e.mu.Lock()
		ids := []uint32{}
		for id, s := range e.streams {
			if s.connection == cmd.Connection {
				ids = append(ids, id)
			}
		}
		e.mu.Unlock()
		for _, id := range ids {
			e.closeStream(id)
		}
		e.driver.Drop(cmd.Connection)
		e.reply(cmd, nil)
	case "health":
		ctx, cancel := context.WithTimeout(e.ctx, 3*time.Second)
		defer cancel()
		if e.driver.Health(ctx) {
			e.reply(cmd, nil)
		} else {
			e.reply(cmd, errors.New("region unreachable"))
		}
	case "probe":
		ctx, cancel := context.WithTimeout(e.ctx, 3*time.Second)
		defer cancel()
		path, err := e.driver.Probe(ctx, cmd.Connection)
		if err != nil {
			e.reply(cmd, err)
		} else {
			e.emit(Event{ID: cmd.ID, Op: cmd.Op, OK: true, Path: &path})
		}
	default:
		e.reply(cmd, ipc.ErrFrame)
	}
}

func (e *engine) accept(conn net.Conn) {
	e.mu.Lock()
	if e.ctx.Err() != nil || len(e.streams) >= ipc.MaxStreams || e.next == 0xffffffff {
		e.mu.Unlock()
		conn.Close()
		return
	}
	id := e.next
	e.next++
	s := &stream{conn: conn, queue: ipc.NewQueue(e.budget, ipc.QueueBytes), cancel: func() {}}
	e.streams[id] = s
	s.timer = time.AfterFunc(5*time.Second, func() { e.closeStreamIf(id, s) })
	e.mu.Unlock()
	e.emit(Event{Op: "accepted", Stream: id})
	e.pump(id, s)
}

func (e *engine) closeStream(id uint32) { e.closeStreamIf(id, nil) }

func (e *engine) closeStreamIf(id uint32, expected *stream) {
	e.mu.Lock()
	s := e.streams[id]
	if expected != nil && s != expected {
		e.mu.Unlock()
		return
	}
	delete(e.streams, id)
	if s != nil && s.timer != nil {
		s.timer.Stop()
	}
	if s != nil || expected == nil {
		e.emit(Event{Op: "closed", Stream: id})
	}
	e.mu.Unlock()
	if s == nil {
		return
	}
	s.cancel()
	s.queue.Close()
	if s.conn != nil {
		s.conn.Close()
	}
}

func (e *engine) pump(id uint32, s *stream) {
	go func() {
		defer e.closeStreamIf(id, s)
		for {
			f, err := ipc.ReadRecordFrame(s.conn, id, e.budget)
			if err != nil {
				return
			}
			e.mu.Lock()
			alive := e.streams[id] == s
			var pushError error
			if alive {
				pushError = e.out.Push(f)
			}
			e.mu.Unlock()
			if !alive || pushError != nil {
				ipc.Release(f)
				return
			}
		}
	}()
	go func() {
		defer e.closeStreamIf(id, s)
		for {
			for {
				f, ok := s.queue.Pop()
				if !ok {
					break
				}
				s.conn.SetWriteDeadline(time.Now().Add(20 * time.Second))
				err := ipc.WriteRecord(s.conn, f.Payload)
				s.queue.Done(f)
				if err != nil {
					return
				}
			}
			e.mu.Lock()
			alive := e.streams[id] == s
			e.mu.Unlock()
			if !alive {
				return
			}
			select {
			case <-e.ctx.Done():
				return
			case <-s.queue.Wake():
			}
		}
	}()
}

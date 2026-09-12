// Package ipc implements the private owner/helper protocol. It has no network
// dependencies and does not interpret Coflux DeviceEnvelope payloads.
package ipc

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
)

const (
	Version          = 1
	Control     byte = 1
	Data        byte = 2
	MaxData          = 30 * 1024 * 1024
	MaxControl       = 64 * 1024
	MaxStreams       = 256
	QueueBytes       = MaxData + 2*1024*1024
	GlobalBytes      = 4 * QueueBytes
)

var ErrFrame = errors.New("invalid transport frame")
var ErrFull = errors.New("transport queue exhausted")

// Frame is BE32(body length), kind:u8, stream:BE32, payload. Control frames
// have stream zero. Data frames have a nonzero stream. Limits are checked before
// allocating the payload, including on truncated or malicious input.
type Frame struct {
	Kind    byte
	Stream  uint32
	Payload []byte
	budget  *Budget
}

func valid(kind byte, stream uint32, n int) bool {
	return (kind == Control && stream == 0 && n > 0 && n <= MaxControl) ||
		(kind == Data && stream != 0 && n > 0 && n <= MaxData)
}

func Read(r io.Reader) (Frame, error) { return ReadBudget(r, nil) }

func ReadBudget(r io.Reader, budget *Budget) (Frame, error) {
	var h [9]byte
	if _, err := io.ReadFull(r, h[:4]); err != nil {
		return Frame{}, err
	}
	n := binary.BigEndian.Uint32(h[:4])
	if n <= 5 || n > MaxData+5 {
		return Frame{}, ErrFrame
	}
	if _, err := io.ReadFull(r, h[4:]); err != nil {
		return Frame{}, err
	}
	kind, stream := h[4], binary.BigEndian.Uint32(h[5:])
	if !valid(kind, stream, int(n)-5) {
		return Frame{}, ErrFrame
	}
	size := int(n) - 5
	if budget != nil && !budget.Reserve(size) {
		return Frame{}, ErrFull
	}
	p := make([]byte, size)
	if _, err := io.ReadFull(r, p); err != nil {
		if budget != nil {
			budget.Release(size)
		}
		return Frame{}, err
	}
	return Frame{Kind: kind, Stream: stream, Payload: p, budget: budget}, nil
}

// Write handles short successful writes instead of assuming one Write is atomic.
func Write(w io.Writer, f Frame) error {
	if !valid(f.Kind, f.Stream, len(f.Payload)) {
		return ErrFrame
	}
	var h [9]byte
	binary.BigEndian.PutUint32(h[:4], uint32(len(f.Payload)+5))
	h[4] = f.Kind
	binary.BigEndian.PutUint32(h[5:], f.Stream)
	if err := WriteAll(w, h[:]); err != nil {
		return err
	}
	return WriteAll(w, f.Payload)
}

func WriteAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(p) {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}

func ReadRecord(r io.Reader) ([]byte, error) {
	var h [4]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(h[:])
	if n == 0 || n > MaxData {
		return nil, ErrFrame
	}
	p := make([]byte, n)
	_, err := io.ReadFull(r, p)
	return p, err
}

func WriteRecord(w io.Writer, p []byte) error {
	if len(p) == 0 || len(p) > MaxData {
		return ErrFrame
	}
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], uint32(len(p)))
	if err := WriteAll(w, h[:]); err != nil {
		return err
	}
	return WriteAll(w, p)
}

// Budget also accounts for queued records waiting behind a blocked stream.
type Budget struct {
	mu    sync.Mutex
	used  int
	limit int
}

func NewBudget(limit int) *Budget { return &Budget{limit: limit} }
func (b *Budget) Reserve(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n < 0 || n > b.limit-b.used {
		return false
	}
	b.used += n
	return true
}
func (b *Budget) Release(n int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.used -= n
	if b.used < 0 {
		panic("transport budget underflow")
	}
}

type Queue struct {
	mu     sync.Mutex
	frames []Frame
	bytes  int
	closed bool
	wake   chan struct{}
	budget *Budget
	limit  int
}

func NewQueue(b *Budget, limit int) *Queue {
	return &Queue{budget: b, limit: limit, wake: make(chan struct{}, 1)}
}
func (q *Queue) Push(f Frame) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := len(f.Payload)
	if q.closed {
		return io.ErrClosedPipe
	}
	if len(q.frames) >= 256 || n > q.limit-q.bytes {
		return ErrFull
	}
	if f.budget != nil && f.budget != q.budget {
		return ErrFrame
	}
	if f.budget == nil {
		if !q.budget.Reserve(n) {
			return ErrFull
		}
		f.budget = q.budget
	}
	q.frames = append(q.frames, f)
	q.bytes += n
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return nil
}
func (q *Queue) Pop() (Frame, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.frames) == 0 {
		return Frame{}, false
	}
	f := q.frames[0]
	q.frames[0] = Frame{}
	q.frames = q.frames[1:]
	q.bytes -= len(f.Payload)
	return f, true
}
func (q *Queue) Wake() <-chan struct{} { return q.wake }
func (q *Queue) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	q.budget.Release(q.bytes)
	q.frames = nil
	q.bytes = 0
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// Done releases a popped frame only after its write completes.
func (q *Queue) Done(f Frame) { Release(f) }

// Release disposes a reserved frame that was not transferred into a queue.
func Release(f Frame) {
	if f.budget != nil {
		f.budget.Release(len(f.Payload))
	}
}

// ReadRecordFrame reserves aggregate capacity before allocating a remote frame.
// A peer stalled halfway through a large frame still owns its full reservation.
func ReadRecordFrame(r io.Reader, stream uint32, budget *Budget) (Frame, error) {
	var h [4]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return Frame{}, err
	}
	n := int(binary.BigEndian.Uint32(h[:]))
	if n <= 0 || n > MaxData {
		return Frame{}, ErrFrame
	}
	if !budget.Reserve(n) {
		return Frame{}, ErrFull
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		budget.Release(n)
		return Frame{}, err
	}
	return Frame{Kind: Data, Stream: stream, Payload: p, budget: budget}, nil
}

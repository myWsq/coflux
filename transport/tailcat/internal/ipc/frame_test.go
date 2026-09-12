package ipc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 2 {
		p = p[:2]
	}
	return w.Buffer.Write(p)
}

func TestFramingFragmentation(t *testing.T) {
	w := new(shortWriter)
	want := Frame{Kind: Data, Stream: 37, Payload: []byte{0, 1, 2, 255, 0, 9}}
	if err := Write(w, want); err != nil {
		t.Fatal(err)
	}
	got, err := Read(w)
	if err != nil || got.Kind != want.Kind || got.Stream != want.Stream || !bytes.Equal(got.Payload, want.Payload) {
		t.Fatalf("frame mismatch: %v", err)
	}
	if _, err = Read(w); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
}
func TestRejectHeadersBeforePayload(t *testing.T) {
	for _, n := range []uint32{0, 5, MaxData + 6, ^uint32(0)} {
		var h [4]byte
		binary.BigEndian.PutUint32(h[:], n)
		if _, err := Read(bytes.NewReader(h[:])); !errors.Is(err, ErrFrame) {
			t.Fatalf("length %d: %v", n, err)
		}
	}
	for _, f := range []Frame{{Kind: Control, Stream: 1, Payload: []byte("{}")}, {Kind: Data, Payload: []byte{1}}, {Kind: 3, Stream: 1, Payload: []byte{1}}, {Kind: Data, Stream: 1}} {
		if !errors.Is(Write(io.Discard, f), ErrFrame) {
			t.Fatal("invalid frame accepted")
		}
	}
}
func TestTruncatedRecord(t *testing.T) {
	for _, p := range [][]byte{{0}, {0, 0, 0, 2, 1}} {
		if _, err := ReadRecord(bytes.NewReader(p)); err == nil {
			t.Fatal("truncated frame accepted")
		}
	}
}
func TestMaximumBinaryRecord(t *testing.T) {
	p := bytes.Repeat([]byte{193}, MaxData)
	var b bytes.Buffer
	if err := WriteRecord(&b, p); err != nil {
		t.Fatal(err)
	}
	got, err := ReadRecord(&b)
	if err != nil || !bytes.Equal(got, p) {
		t.Fatal("maximum record corrupted", err)
	}
}
func TestBudgetIncludesInFlightWritesAndClose(t *testing.T) {
	b := NewBudget(8)
	q := NewQueue(b, 8)
	f := Frame{Kind: Data, Stream: 1, Payload: make([]byte, 8)}
	if q.Push(f) != nil {
		t.Fatal("initial push")
	}
	p, ok := q.Pop()
	if !ok {
		t.Fatal("missing")
	}
	q.Close()
	if b.Reserve(1) {
		t.Fatal("in-flight write was unbounded")
	}
	q.Done(p)
	if !b.Reserve(8) {
		t.Fatal("budget leaked")
	}
	b.Release(8)
	if !errors.Is(q.Push(f), io.ErrClosedPipe) {
		t.Fatal("closed queue accepted frame")
	}
}
func TestQueueExhaustionAndDrain(t *testing.T) {
	b := NewBudget(8)
	a, c := NewQueue(b, 8), NewQueue(b, 8)
	f := Frame{Kind: Data, Stream: 1, Payload: make([]byte, 5)}
	if a.Push(f) != nil || !errors.Is(c.Push(f), ErrFull) {
		t.Fatal("global budget not enforced")
	}
	a.Close()
	if c.Push(f) != nil {
		t.Fatal("close failed to release budget")
	}
	c.Close()
}

func TestBudgetReservedBeforePartialRead(t *testing.T) {
	b := NewBudget(8)
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	done := make(chan error, 1)
	go func() { _, err := ReadRecordFrame(reader, 1, b); done <- err }()
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], 8)
	if _, err := writer.Write(h[:]); err != nil {
		t.Fatal(err)
	}
	// A payload byte can only be read after the entire announced frame is reserved.
	if _, err := writer.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if b.Reserve(1) {
		t.Fatal("partial frame was not charged")
	}
	writer.Close()
	if err := <-done; err == nil {
		t.Fatal("partial frame succeeded")
	}
	if !b.Reserve(8) {
		t.Fatal("partial frame reservation leaked")
	}
	b.Release(8)
}
func TestReadRejectsExhaustionBeforePayload(t *testing.T) {
	b := NewBudget(4)
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], 8)
	if _, err := ReadRecordFrame(bytes.NewReader(h[:]), 1, b); !errors.Is(err, ErrFull) {
		t.Fatalf("allocation not rejected at header: %v", err)
	}
}

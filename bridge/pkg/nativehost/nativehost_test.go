//go:build !windows

package nativehost

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func frame(b []byte) []byte {
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	return append(hdr[:], b...)
}

func TestReadWriteMessage(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteMessage(&buf, []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if got := buf.Bytes()[:4]; binary.LittleEndian.Uint32(got) != 7 {
		t.Fatalf("length prefix %v", got)
	}
	msg, err := ReadMessage(&buf)
	if err != nil || string(msg) != `{"a":1}` {
		t.Fatalf("got %q %v", msg, err)
	}
	if _, err := ReadMessage(&buf); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
	if err := WriteMessage(&buf, make([]byte, MaxToChrome+1)); err == nil {
		t.Fatal("oversized message to Chrome must fail")
	}
}

func TestFramesChunking(t *testing.T) {
	small := []byte(`{"x":"y"}`)
	if f := Frames(small, 1); len(f) != 1 || !bytes.Equal(f[0], small) {
		t.Fatal("small message must pass through")
	}
	big := []byte(`{"data":"` + strings.Repeat("é\"x", 900_000) + `"}`)
	frames := Frames(big, 7)
	if len(frames) < 2 {
		t.Fatalf("want chunks, got %d", len(frames))
	}
	var joined []byte
	for i, f := range frames {
		if len(f) > MaxToChrome {
			t.Fatalf("chunk %d is %d bytes", i, len(f))
		}
		var c chunk
		if err := json.Unmarshal(f, &c); err != nil {
			t.Fatal(err)
		}
		if c.Type != "chunk" || c.ID != 7 || c.I != i || c.N != len(frames) {
			t.Fatalf("bad chunk header %+v", c)
		}
		part, err := base64.StdEncoding.DecodeString(c.Data)
		if err != nil {
			t.Fatal(err)
		}
		joined = append(joined, part...)
	}
	if !bytes.Equal(joined, big) {
		t.Fatal("chunks do not rebuild the message")
	}
}

func TestParseArgs(t *testing.T) {
	t.Setenv("ANTIGEM_BROWSER_SOCKET", "")
	o := ParseArgs([]string{"--native-host", "chrome-extension://abc/", "--socket", "/tmp/x.sock"})
	if o.Origin != "chrome-extension://abc/" || o.Socket != "/tmp/x.sock" {
		t.Fatalf("%+v", o)
	}
	t.Setenv("ANTIGEM_BROWSER_SOCKET", "/run/y.sock")
	if o := ParseArgs(nil); o.Socket != "/run/y.sock" {
		t.Fatalf("env socket not used: %+v", o)
	}
}

// TestRelay runs the host against a fake VS Code socket server and a fake Chrome (pipes).
func TestRelay(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "browser.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	chromeIn, hostIn := io.Pipe()   // Chrome writes -> host reads
	hostOut, chromeOut := io.Pipe() // host writes -> Chrome reads
	done := make(chan int, 1)
	go func() {
		done <- Run(Options{Socket: sock, Origin: "chrome-extension://abc/", In: chromeIn, Out: chromeOut, Log: log.New(io.Discard, "", 0), Retry: 50 * time.Millisecond})
	}()
	readChrome := func() map[string]any {
		msg, err := ReadMessage(hostOut)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(msg, &m); err != nil {
			t.Fatalf("%v: %q", err, msg)
		}
		return m
	}

	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(conn)
	line, _ := r.ReadString('\n')
	if !strings.Contains(line, `"host_hello"`) || !strings.Contains(line, "chrome-extension://abc/") {
		t.Fatalf("hello: %q", line)
	}
	if m := readChrome(); m["type"] != "host_status" || m["connected"] != true {
		t.Fatalf("status: %v", m)
	}

	// Chrome -> VS Code
	go func() { _, _ = hostIn.Write(frame([]byte(`{"type":"hello","version":"1"}`))) }()
	line, _ = r.ReadString('\n')
	if strings.TrimSpace(line) != `{"type":"hello","version":"1"}` {
		t.Fatalf("relayed: %q", line)
	}
	// VS Code -> Chrome
	_, _ = conn.Write([]byte(`{"id":1,"command":"ping"}` + "\n"))
	if m := readChrome(); m["command"] != "ping" {
		t.Fatalf("command: %v", m)
	}
	// a big line arrives in chunks
	big := `{"id":2,"command":"x","payload":"` + strings.Repeat("a", 2*MaxToChrome) + `"}`
	go func() { _, _ = conn.Write([]byte(big + "\n")) }()
	var joined []byte
	for {
		m := readChrome()
		if m["type"] != "chunk" {
			t.Fatalf("want chunk, got %v", m["type"])
		}
		part, _ := base64.StdEncoding.DecodeString(m["data"].(string))
		joined = append(joined, part...)
		if int(m["i"].(float64)) == int(m["n"].(float64))-1 {
			break
		}
	}
	if string(joined) != big {
		t.Fatal("big line not rebuilt")
	}

	// VS Code goes away -> status false, then it comes back -> reconnects
	conn.Close()
	if m := readChrome(); m["connected"] != false {
		t.Fatalf("want disconnected status, got %v", m)
	}
	conn2, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	if m := readChrome(); m["connected"] != true {
		t.Fatalf("want reconnect status, got %v", m)
	}

	// Chrome closes stdin -> host exits
	hostIn.Close()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("host did not exit after Chrome closed the port")
	}
}

func TestOwnedSocket(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "plain")
	_ = os.WriteFile(f, nil, 0o600)
	if err := ownedSocket(f); err == nil || !strings.Contains(err.Error(), "not a socket") {
		t.Fatalf("plain file accepted: %v", err)
	}
	if _, _, err := Dial([]string{filepath.Join(dir, "missing.sock")}); err == nil {
		t.Fatal("missing socket dialed")
	}
}

// Package nativehost is the Chrome Native Messaging host of the AntiGem browser extension
// (`antigem-bridge --native-host`, registered as com.antigem.browser_bridge).
//
// Chrome starts it with the extension's origin as its argument and talks to it over stdin/stdout: every message is a
// uint32 length (native byte order = little-endian on every supported platform) followed by that many bytes of JSON.
// Messages to Chrome may be at most 1 MB, messages from Chrome up to 4 GB.
//
// The host relays those messages to the AntiGem VS Code extension over a per-user Unix socket (newline-delimited JSON):
// the VS Code window that serves the built-in MCP port listens on it, this host connects. No TCP port is ever opened,
// so neither web pages nor other users can reach the browser. Lines from VS Code that are larger than Chrome's limit
// are split into base64 "chunk" messages the extension puts back together.
package nativehost

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// HostName is the native messaging host name the extension connects to.
const HostName = "com.antigem.browser_bridge"

// Version of the host protocol (sent in host_status / host_hello).
const Version = 1

const (
	// MaxToChrome is Chrome's limit for one message from the host.
	MaxToChrome = 1024 * 1024
	// MaxFromChrome caps what we accept from Chrome (its own limit is 4 GB; screenshots are a few MB).
	MaxFromChrome = 256 * 1024 * 1024
	// MaxLine caps one line from VS Code (file uploads built in the page are at most ~35 MB of base64).
	MaxLine = 256 * 1024 * 1024
	// chunkRaw is how many bytes of a large line go into one chunk (base64 grows it by 4/3, ~800 KB).
	chunkRaw = 600 * 1024
)

// ReadMessage reads one native-messaging frame.
func ReadMessage(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n > MaxFromChrome {
		// stay in sync with the stream: skip the oversized message
		if _, err := io.CopyN(io.Discard, r, int64(n)); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("message of %d bytes is larger than %d", n, MaxFromChrome)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// WriteMessage writes one frame (msg must be at most MaxToChrome bytes).
func WriteMessage(w io.Writer, msg []byte) error {
	if len(msg) > MaxToChrome {
		return fmt.Errorf("message of %d bytes is larger than Chrome's limit (%d)", len(msg), MaxToChrome)
	}
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(msg)))
	if _, err := w.Write(append(hdr[:], msg...)); err != nil {
		return err
	}
	return nil
}

// chunk is a piece of a line too large for one Chrome message.
type chunk struct {
	Type string `json:"type"`
	ID   int64  `json:"id"`
	I    int    `json:"i"`
	N    int    `json:"n"`
	Data string `json:"data"`
}

// Frames splits a message for Chrome: as is when it fits, else base64 chunks of at most chunkRaw bytes each.
func Frames(msg []byte, id int64) [][]byte {
	if len(msg) <= MaxToChrome {
		return [][]byte{msg}
	}
	n := (len(msg) + chunkRaw - 1) / chunkRaw
	out := make([][]byte, 0, n)
	for i := 0; i < n; i++ {
		end := (i + 1) * chunkRaw
		if end > len(msg) {
			end = len(msg)
		}
		b, _ := json.Marshal(chunk{Type: "chunk", ID: id, I: i, N: n, Data: base64.StdEncoding.EncodeToString(msg[i*chunkRaw : end])})
		out = append(out, b)
	}
	return out
}

// chromeOut serializes writes to Chrome (stdout).
type chromeOut struct {
	mu     sync.Mutex
	w      io.Writer
	nextID int64
}

func (c *chromeOut) send(msg []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	for _, f := range Frames(msg, c.nextID) {
		if err := WriteMessage(c.w, f); err != nil {
			return err
		}
	}
	return nil
}

func (c *chromeOut) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err == nil {
		_ = c.send(b)
	}
}

// Options of one host run.
type Options struct {
	// Socket forces one socket path (--socket or ANTIGEM_BROWSER_SOCKET); empty = the per-user defaults.
	Socket string
	// Origin Chrome passed (chrome-extension://<id>/).
	Origin string
	In     io.Reader
	Out    io.Writer
	Log    *log.Logger
	// Retry is the pause between connection attempts (default 1 s, 3 s after the first 10 tries).
	Retry time.Duration
}

// ParseArgs reads the host's command line (after --native-host): Chrome adds the caller's origin (and on Windows
// --parent-window=<id>); --socket <path> forces the socket.
func ParseArgs(args []string) Options {
	o := Options{Socket: os.Getenv("ANTIGEM_BROWSER_SOCKET")}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--native-host":
		case a == "--socket" && i+1 < len(args):
			o.Socket = args[i+1]
			i++
		case strings.HasPrefix(a, "--socket="):
			o.Socket = strings.TrimPrefix(a, "--socket=")
		case strings.HasPrefix(a, "chrome-extension://"):
			o.Origin = a
		}
	}
	return o
}

// Run relays between Chrome (stdin/stdout) and the VS Code extension's socket until Chrome closes the port.
func Run(o Options) int {
	if o.In == nil {
		o.In = os.Stdin
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.Log == nil {
		o.Log = log.New(os.Stderr, "[antigem-native-host] ", log.LstdFlags)
	}
	out := &chromeOut{w: o.Out}
	paths := SocketPaths(o.Socket)

	fromChrome := make(chan []byte, 64)
	go func() {
		defer close(fromChrome)
		r := bufio.NewReaderSize(o.In, 64*1024)
		for {
			msg, err := ReadMessage(r)
			if err != nil {
				if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
					o.Log.Printf("read from Chrome: %v", err)
					if strings.Contains(err.Error(), "larger than") {
						continue
					}
				}
				return
			}
			fromChrome <- msg
		}
	}()

	var mu sync.Mutex
	var conn net.Conn
	done := make(chan struct{})
	status := func(connected bool, socket, why string) {
		m := map[string]any{"type": "host_status", "connected": connected, "version": Version, "pid": os.Getpid()}
		if socket != "" {
			m["socket"] = socket
		}
		if why != "" {
			m["error"] = why
		}
		out.sendJSON(m)
	}

	if err := Supported(); err != nil {
		status(false, "", err.Error())
		for range fromChrome {
			status(false, "", err.Error())
		}
		return 0
	}

	// connect loop: VS Code may start after Chrome, restart, or move to another window
	go func() {
		tries := 0
		lastErr := "\x00"
		for {
			select {
			case <-done:
				return
			default:
			}
			c, path, err := Dial(paths)
			if err != nil {
				msg := "VS Code is not running the AntiGem browser bridge (" + err.Error() + ")"
				if msg != lastErr {
					status(false, "", msg)
					lastErr = msg
				}
				tries++
				wait := o.Retry
				if wait == 0 {
					wait = time.Second
					if tries > 10 {
						wait = 3 * time.Second
					}
				}
				select {
				case <-done:
					return
				case <-time.After(wait):
				}
				continue
			}
			tries = 0
			lastErr = "\x00"
			mu.Lock()
			conn = c
			mu.Unlock()
			hello, _ := json.Marshal(map[string]any{"type": "host_hello", "origin": o.Origin, "pid": os.Getpid(), "version": Version})
			_, _ = c.Write(append(hello, '\n'))
			status(true, path, "")
			o.Log.Printf("connected to %s", path)
			r := bufio.NewReaderSize(c, 256*1024)
			for {
				line, err := readLine(r)
				if err != nil {
					break
				}
				line = bytes.TrimSpace(line)
				if len(line) == 0 {
					continue
				}
				if err := out.send(line); err != nil {
					o.Log.Printf("write to Chrome: %v", err)
					return
				}
			}
			mu.Lock()
			if conn == c {
				conn = nil
			}
			mu.Unlock()
			_ = c.Close()
			select {
			case <-done:
				return
			default:
			}
			status(false, "", "VS Code closed the connection")
			time.Sleep(300 * time.Millisecond)
		}
	}()

	for msg := range fromChrome {
		mu.Lock()
		c := conn
		mu.Unlock()
		if c == nil {
			continue
		}
		// Chrome sends compact JSON; make sure one message stays one line
		if bytes.IndexByte(msg, '\n') >= 0 {
			var buf bytes.Buffer
			if json.Compact(&buf, msg) == nil {
				msg = buf.Bytes()
			} else {
				msg = bytes.ReplaceAll(msg, []byte{'\n'}, []byte{' '})
			}
		}
		if _, err := c.Write(append(msg, '\n')); err != nil {
			o.Log.Printf("write to VS Code: %v", err)
			_ = c.Close()
		}
	}
	close(done)
	mu.Lock()
	if conn != nil {
		_ = conn.Close()
	}
	mu.Unlock()
	return 0
}

// readLine reads one newline-terminated line of at most MaxLine bytes.
func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		part, err := r.ReadSlice('\n')
		buf = append(buf, part...)
		if len(buf) > MaxLine {
			return nil, fmt.Errorf("line longer than %d bytes", MaxLine)
		}
		if err == nil {
			return buf, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

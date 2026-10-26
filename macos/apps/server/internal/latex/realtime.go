package latex

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// RealtimeProcess owns the Node host, rtex and its LuaLaTeX engines for one preview.
// Closing stdin lets the host stop the engine tree before its own process exits.
type RealtimeProcess struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	mu     sync.Mutex
	once   sync.Once
	done   chan struct{}
	Events chan json.RawMessage
	log    realtimeLog
}

type realtimeLog struct {
	sync.Mutex
	data string
}

func (b *realtimeLog) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	b.data += string(p)
	if len(b.data) > 12000 {
		b.data = b.data[len(b.data)-12000:]
	}
	return len(p), nil
}
func (p *RealtimeProcess) Log() string {
	p.log.Lock()
	defer p.log.Unlock()
	return strings.TrimSpace(p.log.data)
}

func StartRealtime(rt RealtimeRuntime, src, main, build string) (*RealtimeProcess, error) {
	if !rt.Ready {
		return nil, fmt.Errorf("%s", rt.Reason)
	}
	if err := os.MkdirAll(build, 0755); err != nil {
		return nil, err
	}
	p := &RealtimeProcess{done: make(chan struct{}), Events: make(chan json.RawMessage, 16)}
	p.cmd = exec.Command(rt.Node, rt.Bridge, rt.Engine, src, main, build)
	hideRealtimeWindow(p.cmd)
	texBin := filepath.Dir(rt.LuaLaTeX)
	p.cmd.Env = append(os.Environ(), "RTEX_TEXLIVE_BIN="+texBin, "PATH="+texBin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if os.Getenv("CBCT_ELECTRON_AS_NODE") == "1" {
		p.cmd.Env = append(p.cmd.Env, "ELECTRON_RUN_AS_NODE=1")
	}
	p.cmd.Stderr = &p.log
	var err error
	p.input, err = p.cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := p.cmd.StdoutPipe()
	if err != nil {
		p.input.Close()
		return nil, err
	}
	if err = p.cmd.Start(); err != nil {
		p.input.Close()
		out.Close()
		return nil, err
	}
	go func() {
		defer close(p.Events)
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 64<<10), 128<<20)
		for scanner.Scan() {
			line := append(json.RawMessage(nil), scanner.Bytes()...)
			if json.Valid(line) {
				select {
				case p.Events <- line:
				case <-p.done:
					return
				}
			}
		}
		if err := scanner.Err(); err != nil {
			p.log.Write([]byte(err.Error()))
		}
	}()
	go func() {
		err := p.cmd.Wait()
		if err != nil {
			p.log.Write([]byte(err.Error()))
		}
		close(p.done)
	}()
	return p, nil
}

func (p *RealtimeProcess) Send(command any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	select {
	case <-p.done:
		return fmt.Errorf("实时排版引擎已退出: %s", p.Log())
	default:
	}
	return json.NewEncoder(p.input).Encode(command)
}

func (p *RealtimeProcess) Close() {
	p.once.Do(func() {
		p.input.Close()
		select {
		case <-p.done:
		case <-time.After(12 * time.Second):
			p.cmd.Process.Kill()
			<-p.done
		}
	})
}

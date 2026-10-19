package render

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// UnrenderableFormula reports a formula rejected by the MathJax engine used by
// the Lee PDF renderer.
type UnrenderableFormula struct {
	Tex   string `json:"tex"`
	Error string `json:"error"`
}

type mathCheckRequest struct {
	ID      int    `json:"id"`
	Tex     string `json:"tex"`
	Display bool   `json:"display"`
}

type mathCheckReply struct {
	Ready bool   `json:"ready"`
	ID    int    `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

type mathCheckKey struct {
	tex     string
	display bool
}

type mathCheckResult struct {
	ok    bool
	error string
}

type mathCheckService struct {
	mu       sync.Mutex
	command  *exec.Cmd
	stdin    io.WriteCloser
	lines    chan string
	cache    map[mathCheckKey]mathCheckResult
	nextID   int
	disabled bool
}

var sharedMathCheck = &mathCheckService{cache: map[mathCheckKey]mathCheckResult{}}

// CheckUnrenderableMath asks the bundled MathJax service whether target
// formulas render. Source formulas which fail in exactly the same form are
// excluded. The second result is false when the optional checker is unavailable.
func CheckUnrenderableMath(source, target string) ([]UnrenderableFormula, bool) {
	if strings.TrimSpace(os.Getenv("RETAIN_MATH_RENDER_CHECK")) == "0" {
		return nil, false
	}
	sourceFormulas := mathFormulaMap(source)
	targetFormulas := mathFormulaMap(target)
	if len(targetFormulas) == 0 {
		return nil, true
	}
	keys := make([]mathCheckKey, 0, len(sourceFormulas)+len(targetFormulas))
	seen := map[mathCheckKey]bool{}
	for key := range sourceFormulas {
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	for key := range targetFormulas {
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	results, ok := sharedMathCheck.check(keys)
	if !ok {
		return nil, false
	}
	brokenSource := map[string]bool{}
	for key := range sourceFormulas {
		if result := results[key]; !result.ok {
			brokenSource[compactFormula(key.tex)] = true
		}
	}
	broken := make([]UnrenderableFormula, 0)
	for key, original := range targetFormulas {
		result := results[key]
		if !result.ok && !brokenSource[compactFormula(key.tex)] {
			broken = append(broken, UnrenderableFormula{Tex: original, Error: result.error})
		}
	}
	return broken, true
}

func mathFormulaMap(text string) map[mathCheckKey]string {
	formulas := map[mathCheckKey]string{}
	for index := 0; index < len(text); {
		if text[index] != '$' || escapedMathDollar(text, index) {
			index++
			continue
		}
		width := 1
		if index+1 < len(text) && text[index+1] == '$' {
			width = 2
		}
		end := index + width
		found := false
		for end < len(text) {
			if text[end] == '$' && !escapedMathDollar(text, end) {
				endWidth := 1
				if end+1 < len(text) && text[end+1] == '$' {
					endWidth = 2
				}
				if endWidth == width {
					tex := strings.TrimSpace(text[index+width : end])
					if tex != "" {
						key := mathCheckKey{tex: tex, display: width == 2}
						formulas[key] = tex
					}
					index = end + endWidth
					found = true
					break
				}
			}
			end++
		}
		if !found {
			index++
		}
	}
	return formulas
}

func escapedMathDollar(text string, index int) bool {
	return index > 0 && text[index-1] == '\\'
}

func compactFormula(text string) string { return strings.Join(strings.Fields(text), "") }

func (service *mathCheckService) check(keys []mathCheckKey) (map[mathCheckKey]mathCheckResult, bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.disabled {
		return nil, false
	}
	if err := service.start(); err != nil {
		service.disable(err)
		return nil, false
	}
	pending := make([]mathCheckKey, 0, len(keys))
	for _, key := range keys {
		if _, ok := service.cache[key]; !ok {
			pending = append(pending, key)
		}
	}
	firstID := service.nextID + 1
	for _, key := range pending {
		service.nextID++
		request := mathCheckRequest{ID: service.nextID, Tex: key.tex, Display: key.display}
		encoded, err := json.Marshal(request)
		if err != nil {
			service.disable(err)
			return nil, false
		}
		if _, err = fmt.Fprintln(service.stdin, string(encoded)); err != nil {
			service.disable(err)
			return nil, false
		}
	}
	for index, key := range pending {
		reply, err := service.readReply(20 * time.Second)
		if err != nil {
			service.disable(err)
			return nil, false
		}
		expected := firstID + index
		if reply.ID != expected {
			service.disable(fmt.Errorf("math checker reply id mismatch: expected %d, got %d", expected, reply.ID))
			return nil, false
		}
		service.cache[key] = mathCheckResult{ok: reply.OK, error: reply.Error}
	}
	results := make(map[mathCheckKey]mathCheckResult, len(keys))
	for _, key := range keys {
		results[key] = service.cache[key]
	}
	return results, true
}

func (service *mathCheckService) start() error {
	if service.command != nil && service.command.Process != nil {
		return nil
	}
	engineDir, err := resolveMathCheckEngineDirectory()
	if err != nil {
		return err
	}
	script := filepath.Join(engineDir, "engine", "bin", "rpr-math-check.js")
	if !fileExists(script) {
		return fmt.Errorf("formula check service not found: %s", script)
	}
	node, err := nodeBinary()
	if err != nil {
		return err
	}
	command := exec.Command(node, script)
	command.Dir = filepath.Join(engineDir, "engine")
	command.Env = os.Environ()
	if strings.Contains(strings.ToLower(filepath.Base(node)), "electron") {
		command.Env = append(command.Env, "ELECTRON_RUN_AS_NODE=1")
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return err
	}
	service.command, service.stdin = command, stdin
	service.lines = make(chan string, 32)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			service.lines <- scanner.Text()
		}
		service.lines <- ""
	}()
	line, err := service.readLine(30 * time.Second)
	if err != nil {
		return err
	}
	var ready mathCheckReply
	if err := json.Unmarshal([]byte(line), &ready); err != nil {
		return err
	}
	if !ready.Ready {
		return errors.New("formula check service did not become ready")
	}
	return nil
}

func resolveMathCheckEngineDirectory() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("CBCT_RENDER_ENGINE_DIR")); configured != "" {
		return configured, nil
	}
	candidates := []string{}
	if executable, err := os.Executable(); err == nil {
		base := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(base, "..", "resources", "rendering-engine"),
			filepath.Join(base, "resources", "rendering-engine"),
			filepath.Join(base, "..", "..", "resources", "rendering-engine"),
		)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "resources", "rendering-engine"),
			filepath.Join(cwd, "..", "resources", "rendering-engine"),
			filepath.Join(cwd, "..", "..", "resources", "rendering-engine"),
		)
	}
	for _, candidate := range candidates {
		if fileExists(filepath.Join(candidate, "engine", "bin", "rpr-math-check.js")) {
			absolute, err := filepath.Abs(candidate)
			if err != nil {
				return candidate, nil
			}
			return absolute, nil
		}
	}
	return "", errors.New("formula check service not found")
}

func nodeBinary() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("CBCT_NODE_BIN")); configured != "" {
		if !fileExists(configured) {
			return "", fmt.Errorf("CBCT_NODE_BIN points to a missing file: %s", configured)
		}
		return configured, nil
	}
	return exec.LookPath("node")
}

func (service *mathCheckService) readReply(timeout time.Duration) (mathCheckReply, error) {
	line, err := service.readLine(timeout)
	if err != nil {
		return mathCheckReply{}, err
	}
	var reply mathCheckReply
	if err := json.Unmarshal([]byte(line), &reply); err != nil {
		return mathCheckReply{}, err
	}
	return reply, nil
}

func (service *mathCheckService) readLine(timeout time.Duration) (string, error) {
	if service.lines == nil {
		return "", errors.New("formula check service has no output stream")
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case line := <-service.lines:
		if line == "" {
			return "", errors.New("formula check service exited")
		}
		return line, nil
	case <-timer.C:
		return "", fmt.Errorf("formula check service timed out after %s", timeout)
	}
}

func (service *mathCheckService) disable(err error) {
	service.disabled = true
	log.Printf("公式渲染检查已关闭：%v", err)
	if service.stdin != nil {
		_ = service.stdin.Close()
	}
	if service.command != nil && service.command.Process != nil {
		_ = service.command.Process.Kill()
	}
	service.command, service.stdin, service.lines = nil, nil, nil
}

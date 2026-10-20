package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	paperAbstractStart = regexp.MustCompile(`(?i)\babstract\b\s*[:.]?`)
	paperAbstractEnd   = regexp.MustCompile(`(?im)^\s*(?:\d+(?:\.\d+)*\.?\s+)?introduction\b`)
	repositoryURLMatch = regexp.MustCompile(`https?://[^\s<>"'\])}]+`)
)

const (
	maxRepositoryTreeBytes = 4 << 20
	maxRepositoryBlobBytes = 48 << 10
	maxRepositoryTotal     = 160 << 10
	maxRepositoryFiles     = 12
)

type githubRepository struct {
	DefaultBranch string `json:"default_branch"`
	FullName      string `json:"full_name"`
}

type githubTree struct {
	Truncated bool              `json:"truncated"`
	Tree      []githubTreeEntry `json:"tree"`
}

type githubTreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int    `json:"size"`
	SHA  string `json:"sha"`
}

type githubBlob struct {
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
}

func (s *Server) reproductionRepositoryContext(ctx context.Context, source string) string {
	abstract, repositoryURL := abstractRepositoryURL(source)
	if repositoryURL == "" {
		return "摘要末句未找到以 https:// 开头的公开 GitHub 仓库地址。只能依据论文原文说明复现条件，不得声称已比对仓库。\n摘要内容（节选）：\n" + truncateRepositoryText(abstract, 5000)
	}
	finalSentence := abstractFinalSentence(abstract, repositoryURL)
	contextText, err := s.fetchRepositoryContext(ctx, repositoryURL)
	if err != nil {
		return "摘要末句：" + finalSentence + "\n实际仓库读取失败：" + err.Error() + "\n不得声称已检查仓库代码。\n摘要内容（节选）：\n" + truncateRepositoryText(abstract, 5000)
	}
	return "摘要末句：" + finalSentence + "\n摘要内容：\n" + truncateRepositoryText(abstract, 5000) + "\n\n" + contextText
}

func abstractFinalSentence(abstract, repositoryURL string) string {
	index := strings.LastIndex(abstract, repositoryURL)
	if index < 0 {
		return repositoryURL
	}
	prefix := abstract[:index]
	for i := len(prefix) - 1; i > 0; i-- {
		if (prefix[i] == '.' || prefix[i] == '!' || prefix[i] == '?') && (prefix[i-1] == ' ' || prefix[i-1] == '\n' || prefix[i-1] == '\r' || prefix[i-1] == '\t') {
			prefix = prefix[i+1:]
			break
		}
	}
	return strings.TrimSpace(prefix) + repositoryURL
}

func truncateRepositoryText(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "\n[摘要已截断]"
}

// abstractRepositoryURL finds the repository URL at the end of the abstract,
// instead of accidentally using a later URL from references or body text.
func abstractRepositoryURL(source string) (abstract, repositoryURL string) {
	start := paperAbstractStart.FindStringIndex(source)
	if start == nil {
		return "", ""
	}
	body := paperPageMarker.ReplaceAllString(source[start[1]:], "")
	if end := paperAbstractEnd.FindStringIndex(body); end != nil {
		body = body[:end[0]]
	}
	urls := repositoryURLMatch.FindAllString(body, -1)
	if len(urls) == 0 {
		return strings.TrimSpace(body), ""
	}
	last := strings.TrimRight(urls[len(urls)-1], ".,;:!?")
	parsed, err := url.Parse(last)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "github.com") {
		return strings.TrimSpace(body), ""
	}
	// The repository URL must be in the final abstract sentence. Reject URLs
	// followed by meaningful text so a citation or earlier resource link isn't
	// mistaken for that sentence.
	idx := strings.LastIndex(body, urls[len(urls)-1])
	if idx < 0 || strings.TrimSpace(strings.Trim(body[idx+len(urls[len(urls)-1]):], ".,;:!?")) != "" {
		return strings.TrimSpace(body), ""
	}
	return strings.TrimSpace(body), last
}

func githubRepoPath(repositoryURL string) (string, error) {
	parsed, err := url.Parse(repositoryURL)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "github.com") || parsed.User != nil {
		return "", fmt.Errorf("摘要末句不是有效的 GitHub HTTPS 地址")
	}
	parts := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	if len(parts) < 2 {
		return "", fmt.Errorf("GitHub 地址缺少 owner/repository")
	}
	owner, err := url.PathUnescape(parts[0])
	if err != nil {
		return "", fmt.Errorf("GitHub owner 地址无效")
	}
	repo, err := url.PathUnescape(parts[1])
	if err != nil {
		return "", fmt.Errorf("GitHub repository 地址无效")
	}
	repo = strings.TrimSuffix(repo, ".git")
	valid := regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	if !valid.MatchString(owner) || !valid.MatchString(repo) || owner == "." || owner == ".." || repo == "." || repo == ".." {
		return "", fmt.Errorf("GitHub owner/repository 格式无效")
	}
	return owner + "/" + repo, nil
}

func (s *Server) fetchRepositoryContext(ctx context.Context, repositoryURL string) (string, error) {
	repo, err := githubRepoPath(repositoryURL)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 18 * time.Second}
	base := "https://api.github.com/repos/" + repo
	var metadata githubRepository
	if err := githubJSON(ctx, client, base, 256<<10, &metadata); err != nil {
		return "", fmt.Errorf("读取公开仓库信息失败: %w", err)
	}
	if metadata.DefaultBranch == "" {
		return "", fmt.Errorf("仓库没有可读取的默认分支")
	}
	treeURL := base + "/git/trees/" + url.PathEscape(metadata.DefaultBranch) + "?recursive=1"
	var tree githubTree
	if err := githubJSON(ctx, client, treeURL, maxRepositoryTreeBytes, &tree); err != nil {
		return "", fmt.Errorf("读取仓库文件目录失败: %w", err)
	}
	files := selectRepositoryFiles(tree.Tree)
	if len(files) == 0 {
		return "", fmt.Errorf("仓库目录中没有可读取的说明、配置或源码文件")
	}
	var out strings.Builder
	fmt.Fprintf(&out, "仓库：%s（默认分支 %s）\n摘要地址：%s\n目录是否被 GitHub 截断：%t\n", metadata.FullName, metadata.DefaultBranch, repositoryURL, tree.Truncated)
	out.WriteString("\n仓库文件目录（节选）：\n")
	for _, file := range files {
		fmt.Fprintf(&out, "- %s\n", file.Path)
	}
	out.WriteString("\n已读取的仓库文件：\n")
	used := 0
	readCount := 0
	for _, file := range files {
		if file.Type != "blob" || file.SHA == "" || file.Size > maxRepositoryBlobBytes || file.Size < 0 {
			continue
		}
		remaining := maxRepositoryTotal - used
		if remaining <= 0 || readCount >= maxRepositoryFiles {
			break
		}
		limit := min(maxRepositoryBlobBytes, remaining)
		var blob githubBlob
		if err := githubJSON(ctx, client, base+"/git/blobs/"+file.SHA, int64(limit)+(64<<10), &blob); err != nil || blob.Encoding != "base64" {
			continue
		}
		content, decodeErr := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(blob.Content), ""))
		if decodeErr != nil || len(content) > limit {
			continue
		}
		text := strings.ToValidUTF8(string(content), "�")
		if strings.ContainsRune(text, '\x00') {
			continue
		}
		fmt.Fprintf(&out, "\n--- %s ---\n%s\n", file.Path, text)
		used += len(content)
		readCount++
	}
	if readCount == 0 {
		return "", fmt.Errorf("仓库文件目录可用，但没有成功读取到源码内容（可能受 API 限流或文件格式限制）")
	}
	return out.String(), nil
}

func githubJSON(ctx context.Context, client *http.Client, target string, maxBytes int64, out any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "ReadX-Paper-Reproduction")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1200))
		return fmt.Errorf("GitHub API 返回 HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return fmt.Errorf("GitHub API 响应超过大小限制")
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("解析 GitHub API 响应失败: %w", err)
	}
	return nil
}

func selectRepositoryFiles(entries []githubTreeEntry) []githubTreeEntry {
	// Put project instructions, environment files, and implementation modules
	// ahead of examples and less useful repository files.
	sort.SliceStable(entries, func(i, j int) bool {
		return repositoryFileScore(entries[i].Path) < repositoryFileScore(entries[j].Path)
	})
	if len(entries) > maxRepositoryFiles*3 {
		entries = entries[:maxRepositoryFiles*3]
	}
	return entries
}

func repositoryFileScore(path string) int {
	lower := strings.ToLower(path)
	base := lower[strings.LastIndex(lower, "/")+1:]
	if base == "readme.md" || base == "readme.rst" || base == "readme" {
		return 0
	}
	if strings.HasPrefix(base, "requirements") || base == "pyproject.toml" || base == "environment.yml" || base == "environment.yaml" || base == "setup.py" || base == "cargo.toml" || base == "package.json" || base == "go.mod" {
		return 1
	}
	if strings.HasSuffix(lower, ".py") || strings.HasSuffix(lower, ".go") || strings.HasSuffix(lower, ".rs") || strings.HasSuffix(lower, ".cpp") || strings.HasSuffix(lower, ".cc") || strings.HasSuffix(lower, ".h") || strings.HasSuffix(lower, ".cu") || strings.HasSuffix(lower, ".m") || strings.HasSuffix(lower, ".ipynb") {
		if strings.Contains(lower, "test") || strings.Contains(lower, "example") || strings.Contains(lower, "demo") {
			return 3
		}
		return 2
	}
	if strings.HasSuffix(lower, ".yaml") || strings.HasSuffix(lower, ".yml") || strings.HasSuffix(lower, ".toml") || strings.HasSuffix(lower, ".json") || strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".rst") {
		return 3
	}
	return 10
}

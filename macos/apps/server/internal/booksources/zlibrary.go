package booksources

import (
	"bytes"
	"context"
	"encoding/json"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"cbctv2/server/internal/securefile"
)

// This adapter is independently implemented from the documented EAPI wire
// protocol. It does not bundle an upstream client or Android application keys.
const defaultZLibraryOrigin = "https://z-lib.gd"

type zLibraryGrantKey struct{}
type ZLibraryConfig struct {
	Origin          string   `json:"origin"`
	DownloadOrigins []string `json:"downloadOrigins"`
}
type ZLibraryStatus struct {
	ZLibraryConfig
	Connected      bool   `json:"connected"`
	AccountName    string `json:"accountName,omitempty"`
	DownloadsToday *int   `json:"downloadsToday,omitempty"`
	DailyLimit     *int   `json:"dailyLimit,omitempty"`
	Message        string `json:"message"`
}
type ZLibraryLogin struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	UserID   string `json:"userId"`
	UserKey  string `json:"userKey"`
}
type zSession struct {
	userID, userKey, name string
	today, limit          *int
	ctx                   context.Context
	cancel                context.CancelFunc
}
type ZLibrary struct {
	mu         sync.RWMutex
	config     ZLibraryConfig
	configFile string
	session    *zSession
	proxy      func(*http.Request) (*url.URL, error)
	// The injectable transport is used only by deterministic protocol tests.
	transport  http.RoundTripper
	generation uint64
}

func NewZLibrary(configFile string, proxy func(*http.Request) (*url.URL, error)) *ZLibrary {
	z := &ZLibrary{config: ZLibraryConfig{Origin: defaultZLibraryOrigin, DownloadOrigins: []string{}}, configFile: configFile, proxy: proxy}
	if configFile != "" {
		if f, e := os.Open(configFile); e == nil {
			defer f.Close()
			var cfg ZLibraryConfig
			if json.NewDecoder(io.LimitReader(f, 32<<10)).Decode(&cfg) == nil {
				if _, e := zOrigin(cfg.Origin); e == nil {
					z.config = cfg
				}
			}
		}
	}
	return z
}
func (z *ZLibrary) Info() Source {
	status := z.Status()
	reason := "非官方 EAPI · 请先连接账号"
	if status.Connected {
		reason = "非官方 EAPI · 已连接；按账户额度获取 EPUB/TXT"
	}
	return Source{"zlibrary", "Z-Library", true, Capability{Search: true, Detail: true, Download: true, RequiresAuth: true}, reason}
}
func (z *ZLibrary) Status() ZLibraryStatus {
	z.mu.RLock()
	defer z.mu.RUnlock()
	s := ZLibraryStatus{ZLibraryConfig: z.config, Message: "请在 ReadX 内登录，或填写你自己的会话凭据"}
	s.DownloadOrigins = append([]string{}, z.config.DownloadOrigins...)
	if z.session != nil {
		s.Connected = true
		s.AccountName = z.session.name
		s.DownloadsToday = z.session.today
		s.DailyLimit = z.session.limit
		s.Message = "会话仅保存在本次服务运行期间，密码不保存"
	}
	return s
}
func zOrigin(raw string) (string, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") {
		return "", Fail("SOURCE_NOT_SUPPORTED", "请输入不含路径、端口和凭据的 HTTPS 服务地址", 400)
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
		return "", Fail("SOURCE_NOT_SUPPORTED", "服务地址不能指向本机或内网", 400)
	}
	return "https://" + strings.ToLower(u.Host), nil
}
func (z *ZLibrary) Configure(ctx context.Context, cfg ZLibraryConfig) (ZLibraryStatus, error) {
	origin, e := zOrigin(cfg.Origin)
	if e != nil {
		return ZLibraryStatus{}, e
	}
	cfg.Origin = origin
	if len(cfg.DownloadOrigins) > 8 {
		return ZLibraryStatus{}, Fail("SOURCE_NOT_SUPPORTED", "最多设置 8 个下载源站", 400)
	}
	hosts := map[string]bool{}
	normalized := []string{}
	for _, raw := range append([]string{origin}, cfg.DownloadOrigins...) {
		u, e := zOrigin(raw)
		if e != nil {
			return ZLibraryStatus{}, e
		}
		parsed, _ := url.Parse(u)
		if _, e = resolvePublic(ctx, parsed.Hostname()); e != nil {
			return ZLibraryStatus{}, e
		}
		if u != origin && !hosts[u] {
			normalized = append(normalized, u)
			hosts[u] = true
		}
	}
	cfg.DownloadOrigins = normalized
	z.mu.Lock()
	defer z.mu.Unlock()
	if z.configFile != "" {
		if e = os.MkdirAll(filepath.Dir(z.configFile), 0700); e != nil {
			return ZLibraryStatus{}, Fail("DOWNLOAD_FAILED", "无法保存书源地址", 500)
		}
		data, _ := json.MarshalIndent(cfg, "", "  ")
		if e = os.WriteFile(z.configFile+".tmp", data, 0600); e != nil {
			return ZLibraryStatus{}, Fail("DOWNLOAD_FAILED", "无法保存书源地址", 500)
		}
		if e = os.Rename(z.configFile+".tmp", z.configFile); e != nil {
			_ = os.Remove(z.configFile + ".tmp")
			return ZLibraryStatus{}, Fail("DOWNLOAD_FAILED", "无法保存书源地址", 500)
		}
		_ = securefile.RestrictToCurrentUser(z.configFile)
	}
	if z.session != nil {
		z.session.cancel()
	}
	z.session = nil
	z.config = cfg
	z.generation++
	return ZLibraryStatus{ZLibraryConfig: cfg, Message: "地址已保存，请检查连接或登录"}, nil
}
func (z *ZLibrary) Disconnect() ZLibraryStatus {
	z.mu.Lock()
	if z.session != nil {
		z.session.cancel()
	}
	z.session = nil
	z.generation++
	z.mu.Unlock()
	return z.Status()
}
func (z *ZLibrary) snapshot(auth bool) (ZLibraryConfig, *zSession, uint64, error) {
	z.mu.RLock()
	defer z.mu.RUnlock()
	if auth && z.session == nil {
		return z.config, nil, z.generation, Fail("AUTH_REQUIRED", "请先在书源设置中连接 Z-Library 账号", 401)
	}
	cfg := z.config
	cfg.DownloadOrigins = append([]string{}, cfg.DownloadOrigins...)
	return cfg, z.session, z.generation, nil
}

func (z *ZLibrary) invalidate(s *zSession) {
	if s == nil {
		return
	}
	z.mu.Lock()
	defer z.mu.Unlock()
	if z.session == s {
		s.cancel()
		z.session = nil
		z.generation++
	}
}

var zReference = regexp.MustCompile(`^([1-9][0-9]{0,14}):([a-zA-Z0-9]{4,128})$`)
var zBookAPIPath = regexp.MustCompile(`^/eapi/book/[1-9][0-9]{0,14}/[a-zA-Z0-9]{4,128}(/file)?$`)

func zAPIPath(path string) bool {
	return path == "/eapi/info" || path == "/eapi/user/login" || path == "/eapi/user/profile" || path == "/eapi/book/search" || zBookAPIPath.MatchString(path)
}
func zURL(raw string, cfg ZLibraryConfig, api bool) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" || u.Opaque != "" || u.Hostname() == "" {
		return nil, Fail("SOURCE_NOT_SUPPORTED", "书源返回了不安全的地址", 400)
	}
	origin := "https://" + strings.ToLower(u.Host)
	if api {
		if origin != cfg.Origin || !zAPIPath(u.Path) || u.RawQuery != "" {
			return nil, Fail("SOURCE_NOT_SUPPORTED", "EAPI 地址不在配置的源站内", 400)
		}
	} else {
		allowed := origin == cfg.Origin || u.Hostname() == "cdn-zlib.sk" || strings.HasSuffix(u.Hostname(), ".cdn-zlib.sk")
		for _, host := range cfg.DownloadOrigins {
			if host == origin {
				allowed = true
			}
		}
		if !allowed {
			return nil, Fail("SOURCE_NOT_SUPPORTED", "文件源站尚未允许，请在 Z-Library 设置中添加下载源站", 400)
		}
	}
	return u, nil
}

type zTransport struct {
	base http.RoundTripper
	cfg  ZLibraryConfig
	api  bool
}

func (t zTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if _, e := zURL(r.URL.String(), t.cfg, t.api); e != nil {
		return nil, e
	}
	if _, e := resolvePublic(r.Context(), r.URL.Hostname()); e != nil {
		return nil, e
	}
	return t.base.RoundTrip(r)
}
func (z *ZLibrary) client(cfg ZLibraryConfig, api bool) *http.Client {
	c := newClient(z.proxy)
	base := c.Transport.(guardedTransport).base
	c.Transport = zTransport{base, cfg, api}
	if z.transport != nil {
		c.Transport = z.transport
	}
	c.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if api || len(via) >= 5 {
			return Fail("PROVIDER_UNAVAILABLE", "EAPI 发生跳转或下载跳转过多，请检查配置地址", 502)
		}
		if _, e := zURL(r.URL.String(), cfg, false); e != nil {
			return e
		}
		// Explicitly remove sensitive custom headers when crossing origins. Go's
		// redirect handling does not know that remix-* headers are credentials.
		if len(via) > 0 && r.URL.Host != via[0].URL.Host {
			r.Header.Del("remix-userid")
			r.Header.Del("remix-userkey")
			r.Header.Del("Cookie")
		}
		return nil
	}
	return c
}
func zHeaders(req *http.Request, s *zSession) {
	req.Header.Set("User-Agent", "ReadX/1.0 EAPI client")
	req.Header.Set("Accept", "application/json")
	if s != nil {
		req.Header.Set("remix-userid", s.userID)
		req.Header.Set("remix-userkey", s.userKey)
		req.AddCookie(&http.Cookie{Name: "remix_userid", Value: s.userID})
		req.AddCookie(&http.Cookie{Name: "remix_userkey", Value: s.userKey})
	}
}

type zEnvelope struct {
	Success    json.RawMessage            `json:"success"`
	User       map[string]json.RawMessage `json:"user"`
	Book       json.RawMessage            `json:"book"`
	Books      json.RawMessage            `json:"books"`
	File       zFile                      `json:"file"`
	Pagination struct {
		Current    int             `json:"current"`
		TotalPages int             `json:"total_pages"`
		Next       json.RawMessage `json:"next"`
	} `json:"pagination"`
}

func (z *ZLibrary) api(ctx context.Context, cfg ZLibraryConfig, s *zSession, path string, form url.Values) (zEnvelope, []*http.Cookie, error) {
	var out zEnvelope
	raw := cfg.Origin + path
	if _, e := zURL(raw, cfg, true); e != nil {
		return out, nil, e
	}
	method := "GET"
	var body io.Reader
	if form != nil {
		method = "POST"
		body = strings.NewReader(form.Encode())
	}
	if s != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		stop := context.AfterFunc(s.ctx, cancel)
		defer stop()
		defer cancel()
	}
	req, e := http.NewRequestWithContext(ctx, method, raw, body)
	if e != nil {
		return out, nil, e
	}
	zHeaders(req, s)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res, e := z.client(cfg, true).Do(req)
	if e != nil {
		return out, nil, e
	}
	defer res.Body.Close()
	data, e := io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
	if e != nil {
		return out, nil, e
	}
	if len(data) > 4<<20 {
		return out, nil, Fail("FILE_TOO_LARGE", "EAPI 响应过大", 413)
	}
	if res.StatusCode == 429 {
		return out, nil, Fail("RATE_LIMITED", "接口请求过于频繁或额度不足，请稍后重试", 429)
	}
	if res.StatusCode == 401 || res.StatusCode == 403 {
		z.invalidate(s)
		return out, nil, Fail("AUTH_REQUIRED", "EAPI 拒绝访问，请重新连接账号或检查服务地址", 401)
	}
	if !json.Valid(data) {
		return out, nil, Fail("PROVIDER_UNAVAILABLE", "该地址未返回 EAPI JSON，可能需要在网站完成验证或更换已知服务地址", 502)
	}
	if e = json.Unmarshal(data, &out); e != nil {
		return out, nil, Fail("PROVIDER_UNAVAILABLE", "EAPI 响应结构与当前适配器不兼容", 502)
	}
	success := string(bytes.TrimSpace(out.Success))
	if res.StatusCode != 200 || (success != "1" && success != "true") {
		// Never echo an upstream response that might contain credentials, account
		// identifiers or a private download URL.
		code, status, message := "PROVIDER_UNAVAILABLE", 502, "EAPI 拒绝了请求，请检查账号、服务地址或网站验证状态"
		lower := strings.ToLower(string(data))
		if path == "/eapi/user/login" || strings.Contains(lower, "auth") || strings.Contains(lower, "login") {
			code, status, message = "AUTH_REQUIRED", 401, "登录未成功；若网页账号可用，可使用自己的会话 ID 与 Key 连接"
			z.invalidate(s)
		}
		if strings.Contains(lower, "limit") || strings.Contains(lower, "quota") {
			code, status, message = "RATE_LIMITED", 429, "账号下载额度不足或请求过于频繁"
		}
		return out, nil, Fail(code, message, status)
	}
	return out, res.Cookies(), nil
}
func (z *ZLibrary) Probe(ctx context.Context) (ZLibraryStatus, error) {
	cfg, _, _, _ := z.snapshot(false)
	_, _, e := z.api(ctx, cfg, nil, "/eapi/info", nil)
	if e != nil {
		return ZLibraryStatus{}, e
	}
	s := z.Status()
	s.Message = "EAPI 信息接口可连接；账号搜索与下载需登录后验证"
	return s, nil
}
func jsonString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}
func jsonInt(raw json.RawMessage) *int {
	s := jsonString(raw)
	n, e := strconv.Atoi(s)
	if e != nil || n < 0 {
		return nil
	}
	return &n
}
func userString(user map[string]json.RawMessage, keys ...string) string {
	for _, k := range keys {
		if s := jsonString(user[k]); s != "" {
			return s
		}
	}
	return ""
}

var sessionIDPattern = regexp.MustCompile(`^[0-9]{1,20}$`)
var sessionKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9_+=.\-]{8,512}$`)

func (z *ZLibrary) Connect(ctx context.Context, input ZLibraryLogin) (ZLibraryStatus, error) {
	cfg, _, generation, _ := z.snapshot(false)
	s := &zSession{userID: strings.TrimSpace(input.UserID), userKey: strings.TrimSpace(input.UserKey)}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	keep := false
	defer func() {
		if !keep {
			s.cancel()
		}
	}()
	if s.userID == "" && s.userKey == "" {
		if input.Email == "" || input.Password == "" || len(input.Email) > 320 || len(input.Password) > 1024 {
			return ZLibraryStatus{}, Fail("AUTH_REQUIRED", "请填写邮箱和密码，或自己的会话 ID 与 Key", 400)
		}
		response, cookies, e := z.api(ctx, cfg, nil, "/eapi/user/login", url.Values{"email": {input.Email}, "password": {input.Password}})
		if e != nil {
			return ZLibraryStatus{}, e
		}
		s.userID = userString(response.User, "remix_userid", "id")
		s.userKey = userString(response.User, "remix_userkey", "userkey")
		for _, c := range cookies {
			if c.Name == "remix_userid" {
				s.userID = c.Value
			}
			if c.Name == "remix_userkey" {
				s.userKey = c.Value
			}
		}
	}
	if !sessionIDPattern.MatchString(s.userID) || !sessionKeyPattern.MatchString(s.userKey) {
		return ZLibraryStatus{}, Fail("AUTH_REQUIRED", "接口未返回有效会话；可使用自己的会话 ID 与 Key 连接", 401)
	}
	response, _, e := z.api(ctx, cfg, s, "/eapi/user/profile", nil)
	if e != nil {
		return ZLibraryStatus{}, e
	}
	if len(response.User) == 0 {
		return ZLibraryStatus{}, Fail("AUTH_REQUIRED", "账号资料响应无效，未建立会话", 401)
	}
	s.name = userString(response.User, "name", "username")
	s.today = jsonInt(response.User["downloads_today"])
	s.limit = jsonInt(response.User["downloads_limit"])
	if err := ctx.Err(); err != nil {
		return ZLibraryStatus{}, err
	}
	z.mu.Lock()
	if z.generation != generation {
		z.mu.Unlock()
		return ZLibraryStatus{}, Fail("CANCELLED", "连接期间配置已改变，请重试", 409)
	}
	if z.session != nil {
		z.session.cancel()
	}
	z.session = s
	z.generation++
	keep = true
	z.mu.Unlock()
	return z.Status(), nil
}

type zBook struct {
	ID          json.RawMessage `json:"id"`
	Hash        string          `json:"hash"`
	Title       string          `json:"title"`
	Author      string          `json:"author"`
	Description string          `json:"description"`
	Language    string          `json:"language"`
	Extension   string          `json:"extension"`
	Cover       string          `json:"cover"`
	Identifier  string          `json:"identifier"`
}
type zFile struct {
	DownloadLink  string          `json:"downloadLink"`
	Extension     string          `json:"extension"`
	AllowDownload json.RawMessage `json:"allowDownload"`
}

var descriptionTags = regexp.MustCompile(`<[^>]*>`)

func (b zBook) reference() string {
	id := jsonString(b.ID) + ":" + b.Hash
	if !zReference.MatchString(id) {
		return ""
	}
	return id
}
func (b zBook) book(cfg ZLibraryConfig) Book {
	id := b.reference()
	format := strings.ToLower(strings.TrimPrefix(b.Extension, "."))
	formats := []string{}
	if format == "epub" || format == "txt" {
		formats = append(formats, format)
	}
	authors := []string{}
	if b.Author != "" {
		authors = append(authors, b.Author)
	}
	out := Book{ID: id, ProviderID: "zlibrary", Title: b.Title, Authors: authors, Language: b.Language, ISBN: b.Identifier, Description: html.UnescapeString(descriptionTags.ReplaceAllString(b.Description, "")), Formats: formats, Rights: Rights{Access: "unknown", Reason: "书源未提供作品许可；请确认你有权下载、保存并阅读此书"}, RequiresRightsConfirmation: true}
	parts := zReference.FindStringSubmatch(id)
	if len(parts) == 3 {
		out.SourceURL = cfg.Origin + "/book/" + parts[1] + "/" + parts[2]
	}
	if b.Cover != "" && id != "" {
		out.CoverURL = "/v1/book-sources/zlibrary/books/" + url.PathEscape(id) + "/cover"
	}
	return out
}
func (z *ZLibrary) Search(ctx context.Context, q, cursor string) (SearchResult, error) {
	cfg, s, _, e := z.snapshot(true)
	if e != nil {
		return SearchResult{}, e
	}
	page, e := pageNumber(cursor)
	if e != nil {
		return SearchResult{}, e
	}
	response, _, e := z.api(ctx, cfg, s, "/eapi/book/search", url.Values{"message": {q}, "page": {strconv.Itoa(page)}, "limit": {"20"}, "extensions[]": {"epub", "txt"}})
	if e != nil {
		return SearchResult{}, e
	}
	out := SearchResult{Books: []Book{}}
	var books []zBook
	if json.Unmarshal(response.Books, &books) != nil {
		return SearchResult{}, Fail("PROVIDER_UNAVAILABLE", "EAPI 搜索未返回有效书目列表", 502)
	}
	for _, b := range books {
		if b.reference() != "" && len(out.Books) < 20 {
			out.Books = append(out.Books, b.book(cfg))
		}
	}
	next := string(response.Pagination.Next)
	if response.Pagination.TotalPages > page || (next != "" && next != "null" && next != "false" && next != "0") {
		out.NextCursor = strconv.Itoa(page + 1)
	}
	return out, nil
}
func (z *ZLibrary) record(ctx context.Context, cfg ZLibraryConfig, s *zSession, id string) (zBook, error) {
	parts := zReference.FindStringSubmatch(id)
	if len(parts) != 3 {
		return zBook{}, Fail("SOURCE_NOT_SUPPORTED", "书籍编号或 hash 无效", 400)
	}
	response, _, e := z.api(ctx, cfg, s, "/eapi/book/"+parts[1]+"/"+parts[2], nil)
	if e != nil {
		return zBook{}, e
	}
	var book zBook
	if json.Unmarshal(response.Book, &book) != nil || book.reference() != id {
		return book, Fail("DOWNLOAD_FAILED", "书籍详情缺少匹配的 ID/hash", 502)
	}
	return book, nil
}
func (z *ZLibrary) Detail(ctx context.Context, id string) (Book, error) {
	cfg, s, _, e := z.snapshot(true)
	if e != nil {
		return Book{}, e
	}
	b, e := z.record(ctx, cfg, s, id)
	return b.book(cfg), e
}
func (z *ZLibrary) Download(ctx context.Context, id, format string, progress Progress) (Artifact, error) {
	if ctx.Value(zLibraryGrantKey{}) != id {
		return Artifact{}, Fail("NO_PERMISSION", "请先确认你有权下载、保存并阅读此书", 403)
	}
	cfg, s, _, e := z.snapshot(true)
	if e != nil {
		return Artifact{}, e
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	b, e := z.record(ctx, cfg, s, id)
	if e != nil {
		return Artifact{}, e
	}
	if strings.ToLower(b.Extension) != format || (format != "epub" && format != "txt") {
		return Artifact{}, Fail("INVALID_FORMAT", "该书籍版本不提供所选 EPUB/TXT 格式", 400)
	}
	parts := zReference.FindStringSubmatch(id)
	response, _, e := z.api(ctx, cfg, s, "/eapi/book/"+parts[1]+"/"+parts[2]+"/file", nil)
	if e != nil {
		return Artifact{}, e
	}
	allow := string(response.File.AllowDownload)
	if allow != "true" && allow != "1" {
		return Artifact{}, Fail("NO_PERMISSION", "书源未允许此账号下载该文件，请检查账号额度或权限", 403)
	}
	if response.File.Extension != "" && strings.ToLower(response.File.Extension) != format {
		return Artifact{}, Fail("INVALID_FORMAT", "书源返回的文件格式与所选版本不一致", 400)
	}
	target, e := zURL(response.File.DownloadLink, cfg, false)
	if e != nil {
		return Artifact{}, e
	}
	req, e := http.NewRequestWithContext(ctx, "GET", target.String(), nil)
	if e != nil {
		return Artifact{}, e
	}
	req.Header.Set("User-Agent", "ReadX/1.0 EAPI client")
	if "https://"+target.Host == cfg.Origin {
		zHeaders(req, s)
	}
	res, e := z.client(cfg, false).Do(req)
	if e != nil {
		return Artifact{}, e
	}
	defer res.Body.Close()
	if res.StatusCode == 429 {
		return Artifact{}, Fail("RATE_LIMITED", "账号额度不足或请求过于频繁", 429)
	}
	if res.StatusCode != 200 {
		return Artifact{}, Fail("DOWNLOAD_FAILED", "书源文件下载失败，请重试", 502)
	}
	return readArtifact(ctx, res, parts[1], format, progress)
}
func (z *ZLibrary) Cover(ctx context.Context, id string) ([]byte, string, error) {
	cfg, s, _, e := z.snapshot(true)
	if e != nil {
		return nil, "", e
	}
	b, e := z.record(ctx, cfg, s, id)
	if e != nil {
		return nil, "", e
	}
	u, e := zURL(b.Cover, cfg, false)
	if e != nil {
		return nil, "", e
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	res, e := z.client(cfg, false).Do(req)
	if e != nil {
		return nil, "", e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, "", Fail("DOWNLOAD_FAILED", "封面不可用", 502)
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
	mime := http.DetectContentType(data)
	if e != nil || len(data) > 2<<20 || (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "image/gif") {
		return nil, "", Fail("INVALID_FORMAT", "封面不是受支持的图片", 400)
	}
	return data, mime, nil
}

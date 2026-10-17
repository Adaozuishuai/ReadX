// vision_layout.go：页级版式校正（AI 视觉）。
//
// 定位：视觉模型只做「结构判定」——哪些块属于同一段、每块是什么角色、哪些块应当丢弃。
// 它绝不产出正文：段落文本始终由前端的 PDF 文本层几何重建结果提供，服务端也不会把模型
// 返回的任何文本当成段落内容。因此这里只解析并校验一个纯结构 JSON。
//
// 校验与缓存都在服务端完成，绝不信任模型：
//   - 模型输出必须能被解析成「覆盖全部非 drop 块、按 from 递增、互不重叠」的分组；
//   - 校验不过一律 502 且不写缓存（宁可回退几何判读，也不能让半成品进缓存）；
//   - 缓存 key 里带上 provider/model/提示词版本/图片字节/全部块的指纹，命中直接返回不再调模型。
package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"cbctv2/server/internal/ai"
)

// visionPromptVersion 是提示词的语义版本：只要 system/user prompt 的判定口径变了就要递增，
// 否则旧缓存会按新提示词的语义被复用，版式结果会前后不一致。
const visionPromptVersion = "v1"

const (
	// visionRequestMaxBytes 是请求体上限：一张 8 MiB PNG 的 base64 约 11 MiB，加块列表仍有余量。
	visionRequestMaxBytes = 24 << 20
	// visionBlockLimit 是单页块数上限：一页正文排到 400 块已是极端情况，再多说明前端切块有问题。
	visionBlockLimit = 400
	// visionTextLimit 是每块送进提示词的文本上限（按字符计）：只用于判角色，不需要全文。
	visionTextLimit = 200
	// visionTimeout 给视觉模型 120s：页图推理比纯文本慢，但不能无限等。
	visionTimeout = 120 * time.Second
)

// visionLayoutBlock 是前端几何重建出来的一个文本块。text 只用于让模型判角色，
// 服务端不会把它当段落正文，也不会用模型输出覆盖它。
type visionLayoutBlock struct {
	Index    int     `json:"index"`
	Text     string  `json:"text"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	FontSize float64 `json:"fontSize"`
}

// visionLayoutRequest 是 POST /v1/layout/vision 的请求体。
type visionLayoutRequest struct {
	Page        int                 `json:"page"`
	ImageBase64 string              `json:"imageBase64"`
	Blocks      []visionLayoutBlock `json:"blocks"`
}

// visionPlanGroup / visionPlan 是与前端 PDFTranslationPlan 同形的纯结构输出。
type visionPlanGroup struct {
	From int    `json:"from"`
	To   int    `json:"to"`
	Role string `json:"role"`
}

type visionPlan struct {
	Groups []visionPlanGroup `json:"groups"`
	Drop   []int             `json:"drop"`
}

// visionCacheEntry 是 app_state 里存的缓存镜像：带上 model 与时间，便于排查「这份结果是谁产的」。
type visionCacheEntry struct {
	Plan      visionPlan `json:"plan"`
	Model     string     `json:"model"`
	CreatedAt string     `json:"createdAt"`
}

// visionRoles 是允许的角色集合，与前端 TranslationRole 一一对应。
var visionRoles = map[string]bool{
	"title": true, "heading": true, "body": true, "caption": true, "label": true, "note": true,
}

// visionSystemPrompt 明确「只判结构、不改写正文」：模型看不到也不需要正文产物，
// 因此把「不得改写/翻译/复述」写成第一条硬规则，避免模型把块文本当成要润色的输入。
const visionSystemPrompt = `你是 PDF 版面结构分析器。输入是一页页面的图像，以及该页文本块的编号、坐标和截断后的文本。
你的唯一任务是判断这批块的结构关系，绝不产出正文：
1) 只输出一个 JSON 对象，不要输出解释、前言、后记或 Markdown 代码围栏；
2) 不得改写、翻译、复述、补全任何块的原文，输出里不得出现任何块文本；
3) 只能对给定的编号块做三件事：合并分组（groups）、判定角色（role）、丢弃（drop）；
4) groups 必须覆盖所有未被 drop 的块，每个编号只能出现在一个分组里，按 from 递增且互不重叠；
5) role 只能是 title|heading|body|caption|label|note，缺省 body；
6) drop 只放页眉、页脚、页码、水印、断行残片、跨栏串行碎片等非正文块，不要丢弃段落正文、
   公式、表题、图题或作者/单位行；drop 里的编号必须唯一。
输出格式：{"groups":[{"from":0,"to":1,"role":"body"}],"drop":[]}
只依据版面结构判断，不要依据内容改写。`

// visionUserPrompt 把每个块按「[索引] 文本 + 坐标」列出：坐标是判断栏位与缩进的主要依据。
func visionUserPrompt(page int, blocks []visionLayoutBlock) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "第 %d 页，共 %d 个文本块。块的坐标原点在页面左上角，单位与 PDF 点一致。\n", page, len(blocks))
	builder.WriteString("请判断这些块的结构关系，并按上面的格式只输出 JSON。\n\n")
	for _, block := range blocks {
		fmt.Fprintf(&builder, "[%d] %s\n", block.Index, truncateRunes(block.Text, visionTextLimit))
		fmt.Fprintf(&builder, "    x=%.0f y=%.0f w=%.0f h=%.0f fontSize=%.1f\n",
			block.X, block.Y, block.Width, block.Height, block.FontSize)
	}
	builder.WriteString("\n提醒：只依据版面结构判断，不要依据内容改写；务必覆盖所有未被 drop 的块。")
	return builder.String()
}

// truncateRunes 按字符截断：按字节截会把多字节汉字切成非法 UTF-8，模型会看到乱码。
func truncateRunes(text string, limit int) string {
	trimmed := strings.TrimSpace(text)
	if utf8.RuneCountInString(trimmed) <= limit {
		return trimmed
	}
	return string([]rune(trimmed)[:limit])
}

// handleVisionLayout 接收页图与几何块，返回经服务端校验的版式计划。
func (s *Server) handleVisionLayout(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, visionRequestMaxBytes)
	var body visionLayoutRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "请求体超过 24 MiB 上限")
			return
		}
		writeError(w, http.StatusBadRequest, "请求体必须是 {page, imageBase64, blocks:[{index,text,x,y,width,height,fontSize}]}")
		return
	}
	if body.Page < 1 {
		writeError(w, http.StatusBadRequest, "page 必须 ≥ 1（页码从 1 开始）")
		return
	}
	if strings.TrimSpace(body.ImageBase64) == "" {
		writeError(w, http.StatusBadRequest, "imageBase64 不能为空")
		return
	}
	if len(body.Blocks) == 0 {
		writeError(w, http.StatusBadRequest, "blocks 不能为空")
		return
	}
	if len(body.Blocks) > visionBlockLimit {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("blocks 数量上限 %d 个", visionBlockLimit))
		return
	}
	// index 必须与数组下标一致：下游按 index 直接索引块数组，序号错位会让分组贴到错误的文本上。
	for position, block := range body.Blocks {
		if block.Index != position {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("blocks[%d].index 必须等于 %d（索引从 0 连续递增）", position, position))
			return
		}
	}
	// base64 先按「编码后长度」粗筛再解码：24 MiB 的畸形输入不该先被整体解码进内存。
	if base64.StdEncoding.DecodedLen(len(body.ImageBase64)) > ai.MaxImageBytes+2 {
		writeError(w, http.StatusBadRequest, "图片超过 8 MiB 上限")
		return
	}
	imagePNG, err := base64.StdEncoding.DecodeString(body.ImageBase64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "imageBase64 不是合法的 base64")
		return
	}
	if len(imagePNG) > ai.MaxImageBytes {
		writeError(w, http.StatusBadRequest, "图片超过 8 MiB 上限")
		return
	}

	config, err := s.aiConfig()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	// CLI 渠道在 Ready 之前就拦掉：CLI 的配置通常没有 apiKey，让它先撞 503「未配置」
	// 就会掩盖真正的原因（渠道收不了图），用户永远不知道要换渠道。
	if config.IsCLI() {
		writeError(w, http.StatusBadGateway, ai.ErrImageUnsupportedByCLI)
		return
	}
	if !config.Ready() {
		writeError(w, http.StatusServiceUnavailable, "还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
		return
	}

	cacheKey := visionCacheKey(config.ProviderName(), config.ModelName(), imagePNG, body.Blocks)
	// 缓存读写与模型调用放在同一把「视觉专用」锁内：同一页并发请求不会重复烧额度、不会互相覆盖，
	// 又不占用 appStateMu——那把锁还要服务书库元数据、想法、复现和回收站，不能被 120s 的模型调用堵住。
	s.visionMu.Lock()
	defer s.visionMu.Unlock()

	if entry, found, loadErr := s.loadVisionCache(r.Context(), cacheKey); loadErr != nil {
		// 缓存损坏不应让用户拿不到结果：当作未命中，让模型重算后覆盖它。
		entry, found = visionCacheEntry{}, false
	} else if found {
		writeJSON(w, http.StatusOK, map[string]any{"plan": entry.Plan, "cached": true, "model": entry.Model})
		return
	}

	raw, err := ai.NewClient(config).GenerateWithImage(r.Context(), visionSystemPrompt,
		visionUserPrompt(body.Page, body.Blocks), imagePNG, 0, visionTimeout)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	plan, err := visionPlanFromModel(raw, len(body.Blocks))
	if err != nil {
		// 校验不过绝不写缓存：写进去会把一次坏的判定固化成「这页永远这样分」。
		writeError(w, http.StatusBadGateway, "AI 版式结果无法校验，已回退几何判读")
		return
	}
	_ = s.saveVisionCache(r.Context(), cacheKey, visionCacheEntry{
		Plan: plan, Model: config.ModelName(), CreatedAt: nowStamp(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"plan": plan, "cached": false, "model": config.ModelName()})
}

// visionPlanFromModel 解析并校验模型输出。返回错误即代表整份结果不可用（调用方回退几何判读）。
func visionPlanFromModel(raw string, blockCount int) (visionPlan, error) {
	payload := ai.ExtractJSONObject(stripJSONFence(raw))
	var decoded struct {
		Groups []struct {
			From *int    `json:"from"`
			To   *int    `json:"to"`
			Role *string `json:"role"`
		} `json:"groups"`
		Drop []int `json:"drop"`
	}
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		return visionPlan{}, fmt.Errorf("模型输出不是合法 JSON: %w", err)
	}
	if len(decoded.Groups) == 0 {
		return visionPlan{}, errors.New("模型没有给出任何分组")
	}
	plan := visionPlan{Groups: make([]visionPlanGroup, 0, len(decoded.Groups)), Drop: []int{}}
	for _, group := range decoded.Groups {
		if group.From == nil || group.To == nil {
			return visionPlan{}, errors.New("分组缺少 from 或 to")
		}
		role := "body"
		if group.Role != nil {
			role = strings.TrimSpace(*group.Role)
			if role == "" {
				role = "body"
			}
		}
		if !visionRoles[role] {
			return visionPlan{}, fmt.Errorf("未知角色 %q", role)
		}
		plan.Groups = append(plan.Groups, visionPlanGroup{From: *group.From, To: *group.To, Role: role})
	}
	// 模型偶尔会把分组乱序输出；排序后再校验递增，等价于前端的防御性排序。
	sort.Slice(plan.Groups, func(i, j int) bool { return plan.Groups[i].From < plan.Groups[j].From })

	dropped := map[int]bool{}
	for _, index := range decoded.Drop {
		if index < 0 || index >= blockCount {
			return visionPlan{}, fmt.Errorf("drop 含越界索引 %d", index)
		}
		if dropped[index] {
			return visionPlan{}, fmt.Errorf("drop 含重复索引 %d", index)
		}
		dropped[index] = true
	}
	// 上限与前端一致：max(4, 块数/5)。少块页（半页正文）如果只按比例算，
	// 页眉+页脚两条就会顶破上限，合法结果会被整体丢弃。
	if limit := visionDropLimit(blockCount); len(dropped) > limit {
		return visionPlan{}, fmt.Errorf("drop 数量 %d 超过上限 %d", len(dropped), limit)
	}
	covered := make([]bool, blockCount)
	cursor := 0
	for _, group := range plan.Groups {
		if group.From > group.To {
			return visionPlan{}, fmt.Errorf("分组 %d–%d 的 from 大于 to", group.From, group.To)
		}
		if group.To >= blockCount {
			return visionPlan{}, fmt.Errorf("分组 %d–%d 超出块范围", group.From, group.To)
		}
		// cursor 同时保证「严格递增」与「互不重叠」：任何空洞或回绕都会被这里拒绝。
		if group.From != cursor {
			return visionPlan{}, fmt.Errorf("分组不连续：期望从 %d 开始，实际 %d", cursor, group.From)
		}
		for index := group.From; index <= group.To; index++ {
			if covered[index] {
				return visionPlan{}, fmt.Errorf("块 %d 被多个分组覆盖", index)
			}
			covered[index] = true
		}
		cursor = group.To + 1
	}
	if cursor != blockCount {
		return visionPlan{}, fmt.Errorf("分组只覆盖到 %d，共 %d 块", cursor, blockCount)
	}
	plan.Drop = make([]int, 0, len(dropped))
	for index := 0; index < blockCount; index++ {
		if dropped[index] {
			plan.Drop = append(plan.Drop, index)
		}
	}
	return plan, nil
}

// visionDropLimit 与前端 planIsUsable 的上限逐字对齐：整数除法的截断等价于 JS 的 Math.floor。
func visionDropLimit(blockCount int) int {
	if limit := blockCount / 5; limit > 4 {
		return limit
	}
	return 4
}

// stripJSONFence 剥掉模型裹在 JSON 外的 ``` / ```json 代码围栏。
func stripJSONFence(raw string) string {
	text := strings.TrimSpace(raw)
	if !strings.HasPrefix(text, "```") {
		return text
	}
	text = strings.TrimPrefix(text, "```")
	if newline := strings.Index(text, "\n"); newline >= 0 {
		text = text[newline+1:]
	}
	if end := strings.LastIndex(text, "```"); end >= 0 {
		text = text[:end]
	}
	return text
}

// visionCacheKey 的指纹必须包含「模型可见的全部输入」：换渠道、换模型、换提示词、
// 换图片、换任何一个块的文本或坐标，都必须 miss，绝不能把旧页的版式贴到新页上。
func visionCacheKey(provider, model string, imagePNG []byte, blocks []visionLayoutBlock) string {
	fingerprint := sha256.New()
	fmt.Fprintf(fingerprint, "%s|%s|%s|", provider, model, visionPromptVersion)
	imageSum := sha256.Sum256(imagePNG)
	fingerprint.Write([]byte(hex.EncodeToString(imageSum[:])))
	fingerprint.Write([]byte("|"))
	for _, block := range blocks {
		fmt.Fprintf(fingerprint, "%d\x1f%s\x1f%g\x1f%g\x1f%g\x1f%g\x1f%g\x1e",
			block.Index, block.Text, block.X, block.Y, block.Width, block.Height, block.FontSize)
	}
	return hex.EncodeToString(fingerprint.Sum(nil))
}

func (s *Server) loadVisionCache(ctx context.Context, cacheKey string) (visionCacheEntry, bool, error) {
	var body string
	err := s.handle.QueryRowContext(ctx,
		`SELECT value_json FROM app_state WHERE key = ?`, "vision-layout:"+cacheKey).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return visionCacheEntry{}, false, nil
	}
	if err != nil {
		return visionCacheEntry{}, false, fmt.Errorf("读取版式缓存失败: %w", err)
	}
	var entry visionCacheEntry
	if err := json.Unmarshal([]byte(body), &entry); err != nil {
		return visionCacheEntry{}, false, fmt.Errorf("版式缓存已损坏（不是合法 JSON 对象）: %w", err)
	}
	// 缓存内容也走一遍完整校验：写缓存的是模型输出，但读回来的东西同样不能盲信
	// （磁盘损坏、人工编辑、旧版本写坏的数据都可能在这里出现）。
	plan, err := visionPlanFromModel(mustJSON(entry.Plan), storedBlockCount(entry.Plan))
	if err != nil {
		return visionCacheEntry{}, false, fmt.Errorf("版式缓存不可用: %w", err)
	}
	entry.Plan = plan
	return entry, true, nil
}

func (s *Server) saveVisionCache(ctx context.Context, cacheKey string, entry visionCacheEntry) error {
	encoded, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = s.handle.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		"vision-layout:"+cacheKey, string(encoded), nowStamp())
	return err
}

// storedBlockCount 从分组推断块总数：缓存里没有块列表，但校验通过的分组必然覆盖到最后一块。
func storedBlockCount(plan visionPlan) int {
	count := 0
	for _, group := range plan.Groups {
		if group.To+1 > count {
			count = group.To + 1
		}
	}
	return count
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
)

// visionImageFixture 是一张假的 PNG 字节序列：服务端只做 base64 往返，不解析像素。
func visionImageFixture() []byte { return []byte("\x89PNG\r\n\x1a\n-vision-test") }

// visionBlock 是块列表的构造助手：只关心索引与文本，坐标给一组可辨识的默认值。
func visionBlock(index int, text string) string {
	return fmt.Sprintf(`{"index":%d,"text":%q,"x":47,"y":%d,"width":252,"height":10,"fontSize":10}`,
		index, text, 120+index*12)
}

func visionBlocksJSON(blocks ...string) string { return "[" + strings.Join(blocks, ",") + "]" }

// visionRequest 组装一份合法请求；caller 只覆盖需要变化的部分。
func visionRequest(page int, imageBase64, blocks string) string {
	if imageBase64 == "" {
		imageBase64 = base64.StdEncoding.EncodeToString(visionImageFixture())
	}
	return fmt.Sprintf(`{"page":%d,"imageBase64":%q,"blocks":%s}`, page, imageBase64, blocks)
}

// visionUpstream 起一个假 OpenAI 兼容端点，记录收到的请求体，并按脚本返回 content。
func visionUpstream(t *testing.T, calls *int, content func(payload map[string]any) string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("上游收到的请求体不是合法 JSON: %v", err)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": content(payload)}}},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

// visionServer 造一份「已配好 OpenAI 兼容渠道」的测试服务。
func visionServer(t *testing.T, upstream *httptest.Server) *httptestServerBundle {
	t.Helper()
	bundle, _ := newImportServer(t)
	writeVisionConfig(t, bundle, fmt.Sprintf(`{"baseURL":%q,"model":"vision-model","apiKey":"sk-test"}`, upstream.URL))
	return bundle
}

// writeVisionConfig 直接写 app/config.json（与前端「保存即生效」的路径一致）。
func writeVisionConfig(t *testing.T, bundle *httptestServerBundle, body string) {
	t.Helper()
	path := legacy.NewPaths(bundle.cfg.DataRoot).ConfigFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// visionCall 发一次带图版式请求，并解码响应。
func visionCall(t *testing.T, bundle *httptestServerBundle, body string) (*http.Response, map[string]any) {
	t.Helper()
	return post(t, bundle, http.MethodPost, "/v1/layout/vision", body)
}

// visionGroups 把响应里的 plan.groups 取出来做断言。
func visionGroups(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	plan, ok := payload["plan"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺少 plan: %v", payload)
	}
	raw, ok := plan["groups"].([]any)
	if !ok {
		t.Fatalf("plan.groups 应为数组: %v", plan)
	}
	groups := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		group, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("group 应为对象: %v", item)
		}
		groups = append(groups, group)
	}
	return groups
}

// TestVisionLayoutSendsImageAndCachesResult 覆盖契约里的第 1 条：
// 请求里带 data:image/png;base64 的图片部件，合法分组返回 200，同一请求第二次必须命中缓存。
func TestVisionLayoutSendsImageAndCachesResult(t *testing.T) {
	calls := 0
	var seen map[string]any
	upstream := visionUpstream(t, &calls, func(payload map[string]any) string {
		seen = payload
		// 故意裹一层 ```json 围栏：模型经常这么回，服务端必须自己剥掉。
		// 分组跨度覆盖 drop 位置（与前端一致：drop 的块不参与段落，但要落在某个分组跨度内）。
		return "```json\n{\"groups\":[{\"from\":0,\"to\":1,\"role\":\"body\"},{\"from\":2,\"to\":3,\"role\":\"heading\"}],\"drop\":[3]}\n```"
	})
	bundle := visionServer(t, upstream)
	request := visionRequest(3, "", visionBlocksJSON(
		visionBlock(0, "Sparse-view CBCT reconstruction remains"),
		visionBlock(1, "a challenging ill-posed problem."),
		visionBlock(2, "2. Method"),
		visionBlock(3, "Page 3 of 12"),
	))

	res, payload := visionCall(t, bundle, request)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("合法结果应 200，实际 %d %v", res.StatusCode, payload)
	}
	groups := visionGroups(t, payload)
	if len(groups) != 2 {
		t.Fatalf("应有 2 个分组，实际 %v", groups)
	}
	if groups[0]["from"] != float64(0) || groups[0]["to"] != float64(1) || groups[0]["role"] != "body" {
		t.Fatalf("第一个分组异常: %v", groups[0])
	}
	if groups[1]["from"] != float64(2) || groups[1]["to"] != float64(3) || groups[1]["role"] != "heading" {
		t.Fatalf("第二个分组异常: %v", groups[1])
	}
	if plan := payload["plan"].(map[string]any); fmt.Sprint(plan["drop"]) != "[3]" {
		t.Fatalf("drop 应为 [3]，实际 %v", plan["drop"])
	}
	if payload["cached"] != false || payload["model"] != "vision-model" {
		t.Fatalf("首次请求应 cached=false 且带模型名: %v", payload)
	}

	// 断言上游收到的形状：messages[0].content 必须是含 image_url 的部件数组。
	messages, ok := seen["messages"].([]any)
	if !ok || len(messages) != 2 {
		t.Fatalf("上游应收到 system + user 两条消息，实际 %v", seen["messages"])
	}
	user := messages[1].(map[string]any)
	parts, ok := user["content"].([]any)
	if !ok {
		t.Fatalf("user.content 必须是数组（不是字符串），实际 %T", user["content"])
	}
	if len(parts) != 2 {
		t.Fatalf("user.content 应有 text + image_url，实际 %v", parts)
	}
	imageURL := parts[1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if !strings.HasPrefix(imageURL, "data:image/png;base64,") {
		t.Fatalf("图片必须是 data:image/png;base64 URL，实际 %q", imageURL[:min(48, len(imageURL))])
	}
	want := base64.StdEncoding.EncodeToString(visionImageFixture())
	if imageURL != "data:image/png;base64,"+want {
		t.Fatalf("data URL 与请求里的 base64 不一致")
	}
	if seen["stream"] == true {
		t.Fatal("版式判定必须是非流式")
	}

	// 同一请求再打一次：必须命中缓存，假服务一次都不该被再调用。
	before := calls
	res, cached := visionCall(t, bundle, request)
	if res.StatusCode != http.StatusOK || cached["cached"] != true {
		t.Fatalf("第二次应命中缓存，实际 %d %v", res.StatusCode, cached)
	}
	if calls != before {
		t.Fatalf("命中缓存后不得再调用模型，调用次数从 %d 变成 %d", before, calls)
	}
	if cached["model"] != "vision-model" {
		t.Fatalf("缓存命中也要带模型名: %v", cached)
	}
	if fmt.Sprint(cached["plan"].(map[string]any)["drop"]) != "[3]" {
		t.Fatalf("缓存结果应与首次一致: %v", cached["plan"])
	}

	// 块文本变化必须 miss：否则会把旧页的分组贴到新文本上。
	_, changed := visionCall(t, bundle, visionRequest(3, "", visionBlocksJSON(
		visionBlock(0, "Sparse-view CBCT reconstruction remains"),
		visionBlock(1, "完全不同的续行文本。"),
		visionBlock(2, "2. Method"),
		visionBlock(3, "Page 3 of 12"),
	)))
	if changed["cached"] == true || calls != before+1 {
		t.Fatalf("块文本变化必须重新调用模型: cached=%v calls=%d", changed["cached"], calls)
	}
}

// TestVisionLayoutRejectsUnverifiablePlan 覆盖契约里的第 2 条：
// 模型给出漏块/越界/加料的分组时必须 502，且不得写缓存。
func TestVisionLayoutRejectsUnverifiablePlan(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		// 4 个块：分组必须一直覆盖到 3，否则「未覆盖的块」没有归属。
		{"只覆盖到一半", `{"groups":[{"from":0,"to":1,"role":"body"}],"drop":[]}`},
		{"越界索引", `{"groups":[{"from":0,"to":9,"role":"body"}],"drop":[]}`},
		{"重复覆盖", `{"groups":[{"from":0,"to":2,"role":"body"},{"from":1,"to":3,"role":"body"}],"drop":[]}`},
		{"空洞", `{"groups":[{"from":0,"to":0,"role":"body"},{"from":2,"to":3,"role":"body"}],"drop":[]}`},
		{"未知角色", `{"groups":[{"from":0,"to":3,"role":"gibberish"}],"drop":[]}`},
		{"drop 越界", `{"groups":[{"from":0,"to":3,"role":"body"}],"drop":[9]}`},
		{"drop 重复", `{"groups":[{"from":0,"to":3,"role":"body"}],"drop":[3,3]}`},
		{"不是 JSON", `抱歉，我无法完成这个任务。`},
	}
	blocks := visionBlocksJSON(
		visionBlock(0, "line one"),
		visionBlock(1, "line two"),
		visionBlock(2, "2. Method"),
		visionBlock(3, "Page 3 of 12"),
	)
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			calls := 0
			upstream := visionUpstream(t, &calls, func(map[string]any) string { return testCase.content })
			bundle := visionServer(t, upstream)

			res, payload := visionCall(t, bundle, visionRequest(3, "", blocks))
			if res.StatusCode != http.StatusBadGateway {
				t.Fatalf("无法校验的结果应 502，实际 %d %v", res.StatusCode, payload)
			}
			if message, _ := payload["error"].(string); !strings.Contains(message, "已回退几何判读") {
				t.Fatalf("错误信息应说明已回退几何判读，实际 %v", payload["error"])
			}
			var count int
			if err := bundle.handle.QueryRow(
				`SELECT COUNT(*) FROM app_state WHERE key LIKE 'vision-layout:%'`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("校验不过绝不写缓存，实际写了 %d 条", count)
			}
		})
	}
}

// TestVisionLayoutRequestGuards 覆盖契约里的第 3 条：块索引必须从 0 连续。
func TestVisionLayoutRequestGuards(t *testing.T) {
	calls := 0
	upstream := visionUpstream(t, &calls, func(map[string]any) string {
		return `{"groups":[{"from":0,"to":0,"role":"body"}],"drop":[]}`
	})
	bundle := visionServer(t, upstream)
	image := base64.StdEncoding.EncodeToString(visionImageFixture())

	cases := []struct {
		name    string
		body    string
		message string
	}{
		{"空 blocks", visionRequest(1, "", "[]"), "blocks 不能为空"},
		{"索引从 1 开始", visionRequest(1, "", visionBlocksJSON(visionBlock(1, "a"))), "index"},
		{"索引断档", visionRequest(1, "", visionBlocksJSON(visionBlock(0, "a"), visionBlock(2, "b"))), "index"},
		{"页码 0", visionRequest(0, "", visionBlocksJSON(visionBlock(0, "a"))), "page"},
		{"缺图片", `{"page":1,"imageBase64":"","blocks":` + visionBlocksJSON(visionBlock(0, "a")) + `}`, "imageBase64"},
		{"base64 非法", visionRequest(1, "!!!not-base64!!!", visionBlocksJSON(visionBlock(0, "a"))), "base64"},
		{"请求体不是 JSON", `{"page":1,`, "请求体必须"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			res, payload := visionCall(t, bundle, testCase.body)
			if res.StatusCode != http.StatusBadRequest {
				t.Fatalf("应 400，实际 %d %v", res.StatusCode, payload)
			}
			if message, _ := payload["error"].(string); !strings.Contains(message, testCase.message) {
				t.Fatalf("错误信息应含 %q，实际 %v", testCase.message, payload["error"])
			}
		})
	}
	if calls != 0 {
		t.Fatalf("请求校验不过时不得调用模型，实际调用 %d 次", calls)
	}

	// 图片超过 8 MiB：解出来就超限，必须 400 且不发请求。
	oversized := base64.StdEncoding.EncodeToString(make([]byte, ai.MaxImageBytes+1))
	res, payload := visionCall(t, bundle, visionRequest(1, oversized, visionBlocksJSON(visionBlock(0, "a"))))
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("超大图片应 400，实际 %d %v", res.StatusCode, payload)
	}
	if message, _ := payload["error"].(string); !strings.Contains(message, "8 MiB") {
		t.Fatalf("错误应说明 8 MiB 上限，实际 %v", payload["error"])
	}

	// 超过 400 块：一页不可能有这么多块，说明前端切块出错，直接拒绝而不是烧额度。
	many := make([]string, 0, visionBlockLimit+1)
	for index := 0; index <= visionBlockLimit; index++ {
		many = append(many, visionBlock(index, "x"))
	}
	res, payload = visionCall(t, bundle, visionRequest(1, image, visionBlocksJSON(many...)))
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("超量 blocks 应 400，实际 %d %v", res.StatusCode, payload)
	}
	if message, _ := payload["error"].(string); !strings.Contains(message, "400") {
		t.Fatalf("错误应说明块数上限，实际 %v", payload["error"])
	}
	if calls != 0 {
		t.Fatalf("被拒的请求不得调用模型，实际调用 %d 次", calls)
	}
}

// TestVisionLayoutCLIChannelIsRejected 覆盖契约里的第 4 条（走接口断言）：
// CLI 渠道即使配置不完整，也必须先撞上「不支持图片输入」而不是被当成未配置。
func TestVisionLayoutCLIChannelIsRejected(t *testing.T) {
	calls := 0
	upstream := visionUpstream(t, &calls, func(map[string]any) string { return `{}` })
	bundle := visionServer(t, upstream)
	writeVisionConfig(t, bundle, `{"provider":"codex","model":"gpt-5-codex"}`)

	res, payload := visionCall(t, bundle, visionRequest(1, "", visionBlocksJSON(visionBlock(0, "a"))))
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("CLI 渠道应 502，实际 %d %v", res.StatusCode, payload)
	}
	message, _ := payload["error"].(string)
	if !strings.Contains(message, "不支持图片输入") || !strings.Contains(message, "OpenAI") {
		t.Fatalf("错误应引导用户更换渠道，实际 %v", payload["error"])
	}
	if calls != 0 {
		t.Fatalf("CLI 渠道不得发出 HTTP 请求，实际 %d 次", calls)
	}
}

// TestVisionLayoutRequiresConfiguration：未配置渠道时如实回 503，而不是编一个版式结果。
func TestVisionLayoutRequiresConfiguration(t *testing.T) {
	bundle, _ := newImportServer(t)
	res, payload := visionCall(t, bundle, visionRequest(1, "", visionBlocksJSON(visionBlock(0, "a"))))
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("未配置应 503，实际 %d %v", res.StatusCode, payload)
	}
	if message, _ := payload["error"].(string); !strings.Contains(message, "config.json") {
		t.Fatalf("错误应指向配置文件，实际 %v", payload["error"])
	}
}

// TestVisionLayoutIsTokenGuarded：与其他 /v1 一样必须带 bearer token。
func TestVisionLayoutIsTokenGuarded(t *testing.T) {
	upstream := visionUpstream(t, new(int), func(map[string]any) string { return `{}` })
	bundle := visionServer(t, upstream)
	res := do(t, bundle.frontend, http.MethodPost, "/v1/layout/vision", "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", res.StatusCode)
	}
}

// TestVisionPlanFromModelValidation 覆盖契约里的第 5 条：校验函数是纯函数，单独钉住语义。
func TestVisionPlanFromModelValidation(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		blockCount int
		wantErr    string
	}{
		{"代码围栏", "```json\n{\"groups\":[{\"from\":0,\"to\":1,\"role\":\"body\"}]}\n```", 2, ""},
		{"纯文本围栏", "```\n{\"groups\":[{\"from\":0,\"to\":0}]}\n```", 1, ""},
		{"前后有解说", "好的，结果如下：{\"groups\":[{\"from\":0,\"to\":0,\"role\":\"title\"}]} 以上。", 1, ""},
		{"不合法 JSON", "这不是 JSON", 1, "合法 JSON"},
		{"groups 为空", `{"groups":[]}`, 1, "任何分组"},
		{"缺少 from/to", `{"groups":[{"role":"body"}]}`, 1, "缺少"},
		{"from 大于 to", `{"groups":[{"from":2,"to":1,"role":"body"}]}`, 3, "from 大于 to"},
		{"to 越界", `{"groups":[{"from":0,"to":5,"role":"body"}]}`, 3, "超出块范围"},
		{"覆盖不全", `{"groups":[{"from":0,"to":0,"role":"body"}]}`, 3, "只覆盖到"},
		{"分组间有洞", `{"groups":[{"from":0,"to":0,"role":"body"},{"from":2,"to":2,"role":"body"}]}`, 3, "不连续"},
		{"未知角色", `{"groups":[{"from":0,"to":0,"role":"sidebar"}]}`, 1, "未知角色"},
		{"drop 越界", `{"groups":[{"from":0,"to":0,"role":"body"}],"drop":[3]}`, 1, "越界"},
		{"drop 重复", `{"groups":[{"from":0,"to":1,"role":"body"}],"drop":[0,0]}`, 2, "重复"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			plan, err := visionPlanFromModel(testCase.raw, testCase.blockCount)
			if testCase.wantErr == "" {
				if err != nil {
					t.Fatalf("应通过校验，实际 %v", err)
				}
				if len(plan.Groups) == 0 || plan.Drop == nil {
					t.Fatalf("drop 必须序列化为数组而不是 null: %+v", plan)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("应报含 %q 的错误，实际 %v", testCase.wantErr, err)
			}
		})
	}

	// 缺省 role 必须落到 body；乱序分组排序后应能通过。
	plan, err := visionPlanFromModel(`{"groups":[{"from":2,"to":2},{"from":0,"to":1,"role":"heading"}]}`, 3)
	if err != nil {
		t.Fatalf("乱序但合法的分组应通过: %v", err)
	}
	if plan.Groups[0].From != 0 || plan.Groups[1].Role != "body" {
		t.Fatalf("分组应按下标排序且缺省 body: %+v", plan.Groups)
	}
	if plan.Groups[0].Role != "heading" {
		t.Fatalf("显式角色不得被覆盖: %+v", plan.Groups)
	}

	// drop 上限 = max(4, 块数/5)，与前端 planIsUsable 逐字对齐。
	if limit := visionDropLimit(6); limit != 4 {
		t.Fatalf("6 块的上限应为 4（页眉+页脚不该顶破），实际 %d", limit)
	}
	if limit := visionDropLimit(100); limit != 20 {
		t.Fatalf("100 块的上限应为 20，实际 %d", limit)
	}
	if limit := visionDropLimit(19); limit != 4 {
		t.Fatalf("19 块的上限应为 4，实际 %d", limit)
	}
	// 满 4 条 drop 必须通过校验；第 5 条必须失败。
	blocks := 6
	okDrops := `{"groups":[{"from":0,"to":5,"role":"body"}],"drop":[0,1,2,3]}`
	if _, err := visionPlanFromModel(okDrops, blocks); err != nil {
		t.Fatalf("6 块丢 4 条应通过: %v", err)
	}
	tooMany := `{"groups":[{"from":0,"to":5,"role":"body"}],"drop":[0,1,2,3,4]}`
	if _, err := visionPlanFromModel(tooMany, blocks); err == nil {
		t.Fatal("6 块丢 5 条必须判为无效")
	}

	// 所有错误都必须让调用方回退几何判读，因此不允许返回「半可用」的计划。
	if _, err := visionPlanFromModel(`{"groups":[{"from":0,"to":9,"role":"body"}]}`, 4); err == nil {
		t.Fatal("越界分组不得被接受")
	}
}

// TestVisionPromptsKeepContract：提示词必须固定「只输出 JSON、不得改写正文」的口径，
// user prompt 必须逐块带索引与坐标，供模型判断栏位/缩进。
func TestVisionPromptsKeepContract(t *testing.T) {
	if visionPromptVersion != "v1" {
		t.Fatalf("提示词版本被改动而没有同步递增缓存 key 语义: %q", visionPromptVersion)
	}
	for _, want := range []string{"只输出一个 JSON 对象", "不得改写、翻译、复述", "覆盖所有未被 drop 的块", "title|heading|body|caption|label|note", "只依据版面结构判断"} {
		if !strings.Contains(visionSystemPrompt, want) {
			t.Fatalf("system prompt 缺少 %q", want)
		}
	}
	long := strings.Repeat("字", visionTextLimit+50)
	blocks := []visionLayoutBlock{
		{Index: 0, Text: "Sparse-view CBCT reconstruction", X: 47, Y: 180, Width: 252, Height: 10, FontSize: 10},
		{Index: 1, Text: long, X: 47, Y: 200, Width: 252, Height: 10, FontSize: 9.5},
	}
	prompt := visionUserPrompt(3, blocks)
	for _, want := range []string{"[0] Sparse-view CBCT reconstruction", "x=47 y=180 w=252 h=10 fontSize=10.0", "[1] ", "第 3 页"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("user prompt 缺少 %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, long) {
		t.Fatal("每块文本必须截断到 200 字符")
	}
	if !strings.Contains(prompt, strings.Repeat("字", visionTextLimit)) {
		t.Fatal("截断应保留前 200 字符")
	}
	if !strings.Contains(prompt, "不要依据内容改写") {
		t.Fatal("user prompt 必须提醒只依据版面结构判断")
	}

	// 缓存 key 必须对「模型可见的每一个输入」敏感。
	image := visionImageFixture()
	base := visionCacheKey("openai", "m", image, blocks)
	for _, variant := range []struct {
		name string
		key  string
	}{
		{"换渠道", visionCacheKey("anthropic", "m", image, blocks)},
		{"换模型", visionCacheKey("openai", "other", image, blocks)},
		{"换图片", visionCacheKey("openai", "m", []byte("other-image"), blocks)},
		{"换文本", visionCacheKey("openai", "m", image, []visionLayoutBlock{blocks[0], {Index: 1, Text: "改过的文本", X: 47, Y: 200, Width: 252, Height: 10, FontSize: 9.5}})},
		{"换坐标", visionCacheKey("openai", "m", image, []visionLayoutBlock{blocks[0], {Index: 1, Text: long, X: 48, Y: 200, Width: 252, Height: 10, FontSize: 9.5}})},
	} {
		if variant.key == base {
			t.Fatalf("%s 必须改变缓存 key", variant.name)
		}
	}
	if visionCacheKey("openai", "m", image, blocks) != base {
		t.Fatal("同样的输入必须给出同样的 key")
	}
}

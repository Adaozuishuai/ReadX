// graph.go：知识图谱（取代旧版「趋势与想法」）。
//
// 用 AI 从每篇论文的正文缓存里抽实体（概念/方法/结论）与**带证据的关系**，跨文献合并成图。
// 关键取舍：每条关系的证据必须能回到原文——服务端复用 internal/validate 的同一份逐字核验
// （页码存在 + 摘录 ≥8 非空白字符 + 该页逐字包含），绝不信任模型：核不过的证据丢弃并计入
// dropped，关系因此没有任何证据也一并丢弃，宁可图上少一条边，也不放一条无法回到原文的断言。
//
// 抽取质量的三道约束（v2 起）：
//  1. 规范术语 + 别名：模型尽量用领域通行术语做 label，并把同义写法/中英对照填进 aliases；
//     归一化时 label 与 aliases 一起折成键，键相交即同一实体（同篇在写入时就并，跨篇在
//     GET 读取时并）。逐篇抽取看不到别的篇，所以跨文献合并只能发生在读取侧。
//  2. 受控关系词表：关系 label 必须落在少量正交动词内，词表外的关系丢弃并计入 dropped，
//     而不是整篇 502——一条措辞跑偏的关系不值得让整篇抽取白跑。
//  3. 结论压力：提示词要求至少 3 条该论文自己的 conclusion、且 ≥30% 的关系指向 conclusion；
//     服务端只统计（响应 stats + 日志）不硬性拒绝，避免过度拒绝抽出一张空图。
//
// 存储：app_state['knowledge-graph']（仿 ideas.go 的 load/replace 模式），顶层带
// promptVersion；版本不一致的旧记录整份视为「没抽过」（见 loadGraph 的版本门）。
// 读改写持专用的 graphMu。模型调用长达 180s，绝不能持 appStateMu/graphMu 跨 AI 请求——
// 两把锁都只在 load-modify-save 的短窗口内持有，否则一次抽取会把图谱读写和其它 app_state
// 功能一起卡死。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/validate"
)

const (
	// graphStateKey 是知识图谱在 app_state 里的唯一键。
	graphStateKey = "knowledge-graph"
	// graphPromptVersion 是「提示词 + 归一化/合并规则」的版本号，写在存储契约顶层（与 docs 同级）。
	//
	// 版本门：loadGraph 读出的版本与此不一致（含旧记录根本没这个字段）时，整份图谱按空图处理——
	// GET 返回空、POST extract 的幂等检查也会认为没抽过从而重抽。旧提示词产出的实体名、关系
	// 词表都不满足当前契约，继续展示只会误导；而「哪些旧记录过期」必须由数据自己声明，
	// 不能靠人去猜。刻意不删除旧数据本身：重抽成功时由 replaceGraph 覆盖同一把 key。
	// 改提示词、改归一化/合并规则时必须同步改这里，否则旧记录会被继续当成有效结果。
	graphPromptVersion = "v2"
	// graphMaxEntities / graphMaxRelations 是单篇抽取的硬上限：超出按模型输出顺序取前 N
	//（截断是截断，不计入 dropped——dropped 只数「核验丢弃」，两者混在一起就没法解释）。
	graphMaxEntities   = 60
	graphMaxRelations  = 120
	graphMaterialLimit = 50000
	// graphMaxAliases 是单个实体落库的别名条数上限。提示词要求 ≤4，这里再兜一层：
	// aliases 会进归一化键表，超长输入不该把键表撑爆。
	graphMaxAliases = 12
	// graphConclusionQuota 是「指向 conclusion 的关系占比」的目标值，只用于统计与提示词，
	// 服务端不据此拒绝结果（配额没达标也可能是这篇论文确实只有概念）。
	graphConclusionQuota = 0.30
	// GET 合并时每篇对单条边最多贡献 4 条证据、单边总数 30：防止一条边被单篇论文的
	// 重复摘录撑爆，保证前端展示的证据列表可读且确定有序。
	graphEvidencePerDoc  = 4
	graphEvidencePerEdge = 30
)

// ---- 受控关系词表 ----
//
// 为什么要有受控词表：逐篇独立抽取时，模型对同一种语义会写出「使用/采用/利用/用到/基于」
// 等几十种说法（实测 105 条边用了 24 种 label），图上的关系因此既不可比也不可读，前端配色
// 与图例也没法收敛。这里只保留少量语义正交的动词，模型给出了表外措辞就丢弃该关系并计入
// dropped（不是整份 502）。
//
// 新增受控词时的纪律：
//   - 只加「语义确实正交、模型高频会用」的词，并同步更新前端配色/图例
//     （apps/web 的 KnowledgeGraphSection 按 label 上色/分组）；
//   - 同义写法（含英文）请加进 graphRelationAliases，不要往这里加新 label。
var graphRelationLabels = []string{
	// 论证链最常用的方向性动词：概念 → 方法 → 结论的骨架靠它们连起来。
	"基于", "使用", "改进", "解决", "应用于", "属于", "对比", "优于", "支持", "导致", "产生", "评估", "包含", "得出",
}

// graphRelationStems 是受控 label 的折叠形式（全角→半角、小写、标点当分隔符、空白压缩），
// 让模型写成「基于 」或「Based-on」也认得出。
var graphRelationStems = func() map[string]string {
	stems := make(map[string]string, len(graphRelationLabels))
	for _, label := range graphRelationLabels {
		stems[foldGraphText(label)] = label
	}
	return stems
}()

// graphRelationAliases 把英文与常见同义写法映射回受控词表的 label；key 是折叠后的写法。
var graphRelationAliases = map[string]string{
	// 基于 / based on
	"based on": "基于", "basedon": "基于", "base on": "基于", "build on": "基于",
	"builds on": "基于", "built on": "基于", "built upon": "基于", "derived from": "基于",
	"derive from": "基于", "extends": "基于", "extend": "基于", "extension of": "基于",
	"依托": "基于", "建立在": "基于", "源自": "基于", "沿用": "基于",
	// 使用 / use
	"use": "使用", "uses": "使用", "used": "使用", "using": "使用", "adopt": "使用",
	"adopts": "使用", "adopted": "使用", "employ": "使用", "employs": "使用",
	"utilize": "使用", "utilizes": "使用", "leverage": "使用", "leverages": "使用",
	"采用": "使用", "利用": "使用", "用到": "使用",
	// 改进 / improve。刻意只收「变好」的同义词：像 reduce/降低 这类「变小」的写法方向不同，
	// 硬塞进「改进」会把断言拧反，宁可让它们落到表外被丢弃。
	"improve": "改进", "improves": "改进", "improved": "改进", "improvement": "改进",
	"enhance": "改进", "enhances": "改进", "enhanced": "改进", "refine": "改进", "refines": "改进",
	"提升": "改进", "优化": "改进", "改良": "改进",
	// 解决 / address
	"address": "解决", "addresses": "解决", "solve": "解决", "solves": "解决",
	"overcome": "解决", "overcomes": "解决", "handle": "解决", "handles": "解决",
	"tackle": "解决", "tackles": "解决", "mitigate": "解决", "mitigates": "解决",
	"缓解": "解决", "克服": "解决", "处理": "解决",
	// 应用于 / applied to
	"apply to": "应用于", "applied to": "应用于", "applies to": "应用于",
	"used for": "应用于", "used in": "应用于", "use for": "应用于", "use in": "应用于",
	"用于": "应用于", "用在": "应用于",
	// 属于 / belong to
	"belong to": "属于", "belongs to": "属于", "belonging to": "属于",
	"is a": "属于", "is an": "属于", "is a kind of": "属于", "kind of": "属于",
	"type of": "属于", "subset of": "属于", "part of": "属于", "是一种": "属于",
	// 对比 / compare
	"compare": "对比", "compares": "对比", "compared": "对比", "compared with": "对比",
	"compared to": "对比", "comparison": "对比", "versus": "对比", "vs": "对比",
	"contrast": "对比", "contrasts": "对比", "比较": "对比", "相比": "对比",
	// 优于 / outperform
	"outperform": "优于", "outperforms": "优于", "outperformed": "优于",
	"surpass": "优于", "surpasses": "优于", "better than": "优于", "superior to": "优于",
	"exceed": "优于", "exceeds": "优于", "beat": "优于", "beats": "优于",
	"超过": "优于", "高于": "优于", "领先": "优于",
	// 支持 / support
	"support": "支持", "supports": "支持", "supported": "支持",
	"confirm": "支持", "confirms": "支持", "validate": "支持", "validates": "支持",
	"corroborate": "支持", "证实": "支持", "证明": "支持", "验证": "支持",
	// 导致 / cause
	"cause": "导致", "causes": "导致", "lead to": "导致", "leads to": "导致",
	"leading to": "导致", "result in": "导致", "results in": "导致",
	"induce": "导致", "induces": "导致", "引起": "导致", "造成": "导致",
	// 产生 / produce
	"produce": "产生", "produces": "产生", "generate": "产生", "generates": "产生",
	"yield": "产生", "yields": "产生", "render": "产生", "renders": "产生",
	"生成": "产生", "渲染出": "产生",
	// 评估 / evaluate
	"evaluate": "评估", "evaluates": "评估", "evaluated": "评估", "evaluation": "评估",
	"assess": "评估", "assesses": "评估", "measure": "评估", "measures": "评估",
	"benchmark": "评估", "benchmarks": "评估", "评测": "评估", "衡量": "评估", "测量": "评估",
	// 包含 / include
	"include": "包含", "includes": "包含", "including": "包含", "contain": "包含",
	"contains": "包含", "consist of": "包含", "consists of": "包含",
	"comprise": "包含", "comprises": "包含", "包括": "包含", "涵盖": "包含",
	// 得出 / conclude（旧提示词的「得到」在这里回到受控词表，历史夹具因此不需要改）
	"conclude": "得出", "concludes": "得出", "conclusion": "得出", "derive": "得出",
	"obtain": "得出", "obtains": "得出", "find": "得出", "finds": "得出",
	"show": "得出", "shows": "得出", "demonstrate": "得出", "demonstrates": "得出",
	"得到": "得出", "得到结论": "得出", "表明": "得出", "显示": "得出", "发现": "得出",
}

// ---- 存储契约（app_state['knowledge-graph'] 的 value_json）----
//
// {
//   "promptVersion": "v2",
//   "docs": {"<docKey>": {"title":"","extractedAt":"",
//     "entities":[{"id":"","label":"","kind":"","aliases":[]}],
//     "relations":[{"from":"<id>","to":"<id>","label":"<受控词>","evidence":[{"page":1,"excerpt":""}]}],
//     "dropped":0,"stats":{...}}}
// }
//
// 向后兼容约定（旧记录不许报错）：
//   - 实体没有 aliases 字段 → 读出来是 nil，按空数组参与合并与展示；
//   - 文档没有 stats 字段 → 读出来全零，graphStatsOf 会重算可推导的部分；
//   - 顶层没有/不是 promptVersion="v2" → 整份图谱视为过期（loadGraph 的版本门）。

// graphEntity 是一个已核验归属的节点：id 归一化后跨文献合并，label 保留原样展示。
// Aliases 是模型给出的同义写法（含中英对照）：它们与 label 一起参与归一化合并。
type graphEntity struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Kind    string   `json:"kind"`
	Aliases []string `json:"aliases"`
}

// graphEvidence 是一条已通过逐字核验的原文摘录（页码 + 摘录）。
type graphEvidence struct {
	Page    int    `json:"page"`
	Excerpt string `json:"excerpt"`
}

// graphRelation 是一条带证据的关系；from/to 存的是实体 id（不是 label）。
type graphRelation struct {
	From     string          `json:"from"`
	To       string          `json:"to"`
	Label    string          `json:"label"`
	Evidence []graphEvidence `json:"evidence"`
}

// graphExtractionStats 是一次抽取的丢弃明细，随文档一起落库：
// 让「图上为什么少了一条边」可解释——是词表外、端点缺失还是证据核不过，分别计数。
// 可推导的计数（实体/关系/结论）不依赖这份明细，graphStatsOf 会现算。
type graphExtractionStats struct {
	MergedEntities    int `json:"mergedEntities"`
	DroppedVocabulary int `json:"droppedVocabulary"`
	DroppedEndpoint   int `json:"droppedEndpoint"`
	DroppedEvidence   int `json:"droppedEvidence"`
}

// graphDocExtraction 是一篇论文一次抽取的落库结果。
type graphDocExtraction struct {
	Title       string               `json:"title"`
	ExtractedAt string               `json:"extractedAt"`
	Entities    []graphEntity        `json:"entities"`
	Relations   []graphRelation      `json:"relations"`
	Dropped     int                  `json:"dropped"`
	Stats       graphExtractionStats `json:"stats"`
}

// knowledgeGraph 是 app_state 值的顶层形状：{"promptVersion":"v2","docs":{<docKey>: ...}}。
type knowledgeGraph struct {
	PromptVersion string                        `json:"promptVersion"`
	Docs          map[string]graphDocExtraction `json:"docs"`
}

func newKnowledgeGraph() *knowledgeGraph {
	return &knowledgeGraph{PromptVersion: graphPromptVersion, Docs: map[string]graphDocExtraction{}}
}

// ---- 响应形状 ----

type graphNode struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Kind  string   `json:"kind"`
	Docs  []string `json:"docs"`
	// Aliases 是合并后节点保留的全部同义写法（已剔除与 label 同键的项）；旧客户端可忽略。
	Aliases []string `json:"aliases"`
}

// graphEdgeEvidence 是 GET 合并时由服务端注入 paperKey/paperTitle 的证据条目：
// 前端要能从证据直接跳回论文，不能只有页码和摘录。
type graphEdgeEvidence struct {
	PaperKey   string `json:"paperKey"`
	PaperTitle string `json:"paperTitle"`
	Page       int    `json:"page"`
	Excerpt    string `json:"excerpt"`
}

type graphEdge struct {
	ID       string              `json:"id"`
	From     string              `json:"from"`
	To       string              `json:"to"`
	Label    string              `json:"label"`
	Docs     []string            `json:"docs"`
	Evidence []graphEdgeEvidence `json:"evidence"`
}

// graphPaper 是「这篇论文抽得怎么样」的统一视图（extract 响应与 GET papers 共用同形）。
type graphPaper struct {
	Key           string `json:"key"`
	Title         string `json:"title"`
	ExtractedAt   string `json:"extractedAt"`
	NodeCount     int    `json:"nodeCount"`
	RelationCount int    `json:"relationCount"`
	Dropped       int    `json:"dropped"`
}

func newGraphPaper(key string, doc graphDocExtraction) graphPaper {
	return graphPaper{
		Key: key, Title: doc.Title, ExtractedAt: doc.ExtractedAt,
		NodeCount: len(doc.Entities), RelationCount: len(doc.Relations), Dropped: doc.Dropped,
	}
}

// graphStats 是单篇抽取的质量统计：随 extract 响应回给前端，也写一条日志。
// 它是新字段，前端可忽略；存在的意义是让「合并率低 / 结论太少 / 关系被词表丢掉」一眼可辨。
type graphStats struct {
	Entities           int     `json:"entities"`
	Relations          int     `json:"relations"`
	Conclusions        int     `json:"conclusions"`
	ConclusionLinks    int     `json:"conclusionLinks"`
	ConclusionRatio    float64 `json:"conclusionRatio"`
	ConclusionQuotaMet bool    `json:"conclusionQuotaMet"`
	MergedEntities     int     `json:"mergedEntities"`
	Dropped            int     `json:"dropped"`
	DroppedVocabulary  int     `json:"droppedVocabulary"`
	DroppedEndpoint    int     `json:"droppedEndpoint"`
	DroppedEvidence    int     `json:"droppedEvidence"`
	// DroppedOther 只可能出现在旧记录上（历史 dropped 没有分类明细），保证总数可解释。
	DroppedOther int `json:"droppedOther"`
}

// graphHealth 是 GET 合并后整张图的健康度：跨文献合并率与结论占比是这次改造的两个目标。
type graphHealth struct {
	PromptVersion      string  `json:"promptVersion"`
	Documents          int     `json:"documents"`
	Nodes              int     `json:"nodes"`
	Edges              int     `json:"edges"`
	CrossDocumentNodes int     `json:"crossDocumentNodes"`
	CrossDocumentEdges int     `json:"crossDocumentEdges"`
	Conclusions        int     `json:"conclusions"`
	ConclusionLinks    int     `json:"conclusionLinks"`
	ConclusionRatio    float64 `json:"conclusionRatio"`
	MergedEntities     int     `json:"mergedEntities"`
}

// ---- 模型（不可信）输出的解码目标 ----

// graphStringList 是 aliases 的解码类型：提示词要求字符串数组，但模型偶尔会写成单个字符串
// 或混进 null。为这点格式偏差废掉整篇抽取不值得（别名只是合并的辅助信息，不是证据），
// 所以这里宽进：字符串当单元素数组、数组里的非字符串元素丢弃、null 当空数组。
type graphStringList []string

func (list *graphStringList) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*list = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var values []any
		if err := json.Unmarshal(data, &values); err != nil {
			return err
		}
		decoded := make([]string, 0, len(values))
		for _, value := range values {
			if text, ok := value.(string); ok {
				decoded = append(decoded, text)
			}
		}
		*list = decoded
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	*list = []string{text}
	return nil
}

// graphModelOutput 只描述 JSON 形状，不做任何信任假设：类型对不上在 Unmarshal 阶段
// 就失败（→502），语义问题按契约顺序在 parseGraphModelOutput 里逐条处理。
// aliases 是可选字段：缺失是 nil，等价于空数组。
type graphModelOutput struct {
	Entities []struct {
		Label   string          `json:"label"`
		Kind    string          `json:"kind"`
		Aliases graphStringList `json:"aliases"`
	} `json:"entities"`
	Relations []struct {
		From     string `json:"from"`
		To       string `json:"to"`
		Label    string `json:"label"`
		Evidence []struct {
			// Page 用 any 接：提示词要求写「第 N 页」这样的枚举，数字形式也照收
			// （见 graphPageNumber）；两者之外的类型仍然当类型错误 → 502。
			Page    any    `json:"page"`
			Excerpt string `json:"excerpt"`
		} `json:"evidence"`
	} `json:"relations"`
}

// ---- handler ----

// handleGraphList 合并所有文档的抽取结果成一张跨文献图谱。
func (s *Server) handleGraphList(w http.ResponseWriter, r *http.Request) {
	// 短锁读：loadGraph 完成即放锁，合并与计数都在锁外做。
	s.graphMu.Lock()
	graph, err := s.loadGraph(r.Context())
	s.graphMu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 有正文缓存的文档总数：前端用它算「未抽取 N 篇」。
	var totalDocuments int
	if err := s.handle.QueryRowContext(r.Context(),
		`SELECT COUNT(DISTINCT document_id) FROM document_pages WHERE length(text) > 0`).
		Scan(&totalDocuments); err != nil {
		writeError(w, http.StatusInternalServerError, "统计正文缓存失败: "+err.Error())
		return
	}

	// 按 docKey 升序遍历：节点 label/kind 取按序第一篇的贡献，证据排序也依赖这个顺序。
	docKeys := make([]string, 0, len(graph.Docs))
	for key := range graph.Docs {
		docKeys = append(docKeys, key)
	}
	sort.Strings(docKeys)

	// 把所有篇的实体铺平成一条序列（docKey 升序、篇内按模型输出顺序）后统一归并：
	// 归并规则与写入侧 parseGraphModelOutput 用的是同一个函数，同篇/跨篇不会出现两套判定。
	entries := make([]graphEntityEntry, 0)
	for _, key := range docKeys {
		for _, entity := range graph.Docs[key].Entities {
			entries = append(entries, graphEntityEntry{DocKey: key, Entity: entity})
		}
	}
	merged, groupOfEntry := mergeGraphEntities(entries)

	nodes := make([]graphNode, 0, len(merged))
	for _, node := range merged {
		nodes = append(nodes, graphNode{
			ID: node.ID, Label: node.Label, Kind: node.Kind, Docs: node.Docs, Aliases: node.Aliases,
		})
	}

	// 端点改写表：篇内实体 id（以及任何 label/别名折叠键，兼容手写/历史记录）→ 全局节点 id。
	// 两篇的同一实体并成一个节点后，关系端点必须跟着改写，否则边会挂在已被并掉的旧 id 上
	// 变成悬空边——跨文献的边正是靠这一步才连得起来。
	globalIDByDoc := map[string]map[string]string{}
	globalIDByKey := map[string]string{}
	for position, entry := range entries {
		globalID := merged[groupOfEntry[position]].ID
		byDoc := globalIDByDoc[entry.DocKey]
		if byDoc == nil {
			byDoc = map[string]string{}
			globalIDByDoc[entry.DocKey] = byDoc
		}
		byDoc[graphEntityID(entry.Entity)] = globalID
		for _, key := range entityKeys(entry.Entity.Label, entry.Entity.Aliases) {
			if _, ok := globalIDByKey[key]; !ok {
				globalIDByKey[key] = globalID
			}
		}
	}
	resolveEndpoint := func(docKey, endpoint string) (string, bool) {
		if globalID, ok := globalIDByDoc[docKey][endpoint]; ok {
			return globalID, true
		}
		globalID, ok := globalIDByKey[normalizeEntityID(endpoint)]
		return globalID, ok
	}

	// 全程持有指针，最后才物化成响应切片：中途写进切片的是拷贝，
	// 后续对同一节点的边合并（append docs、append evidence）就丢了。
	edgeOrder := []*graphEdge{}
	edgeByID := map[string]*graphEdge{}
	papers := make([]graphPaper, 0, len(docKeys))

	for _, key := range docKeys {
		doc := graph.Docs[key]
		papers = append(papers, newGraphPaper(key, doc))

		// perDoc 记「当前这篇对单条边已贡献的证据数」：「每篇 ≤4 条」按边累计，
		// 同一篇内多条同边关系共享这个额度。
		perDoc := map[string]int{}
		for _, relation := range doc.Relations {
			from, fromOK := resolveEndpoint(key, relation.From)
			to, toOK := resolveEndpoint(key, relation.To)
			if !fromOK || !toOK {
				// 端点在合并后的节点集里找不到（实体被截断或历史数据）：静默跳过，不造悬空边。
				continue
			}
			edgeID := from + "→" + to + "→" + relation.Label
			edge, ok := edgeByID[edgeID]
			if !ok {
				edge = &graphEdge{
					ID: edgeID, From: from, To: to, Label: relation.Label,
					Docs: []string{}, Evidence: []graphEdgeEvidence{},
				}
				edgeByID[edgeID] = edge
				edgeOrder = append(edgeOrder, edge)
			}
			if !hasString(edge.Docs, key) {
				edge.Docs = append(edge.Docs, key)
			}
			for _, item := range relation.Evidence {
				if perDoc[edgeID] >= graphEvidencePerDoc || len(edge.Evidence) >= graphEvidencePerEdge {
					break
				}
				perDoc[edgeID]++
				edge.Evidence = append(edge.Evidence, graphEdgeEvidence{
					PaperKey: key, PaperTitle: doc.Title, Page: item.Page, Excerpt: item.Excerpt,
				})
			}
		}
	}

	// 证据排序：docKey 升序、页码升序（stable，同页保留模型顺序）。上面按 docKey 升序
	// 追加已保证篇间顺序，这里再显式排序一次，把契约钉死在数据上而不是遍历顺序上。
	for _, edge := range edgeOrder {
		sort.SliceStable(edge.Evidence, func(a, b int) bool {
			if edge.Evidence[a].PaperKey != edge.Evidence[b].PaperKey {
				return edge.Evidence[a].PaperKey < edge.Evidence[b].PaperKey
			}
			return edge.Evidence[a].Page < edge.Evidence[b].Page
		})
	}

	edges := make([]graphEdge, 0, len(edgeOrder))
	for _, edge := range edgeOrder {
		edges = append(edges, *edge)
	}

	// 全局健康度：改造前实测「105 条边、跨文献边 0 条、conclusion 4%」，
	// 这三个数字现在直接放在响应里，不用再靠外部脚本统计。
	kindByID := map[string]string{}
	health := graphHealth{PromptVersion: graph.PromptVersion, Documents: len(docKeys)}
	for _, node := range nodes {
		kindByID[node.ID] = node.Kind
		if node.Kind == "conclusion" {
			health.Conclusions++
		}
		if len(node.Docs) > 1 {
			health.CrossDocumentNodes++
		}
	}
	for _, edge := range edges {
		if kindByID[edge.To] == "conclusion" {
			health.ConclusionLinks++
		}
		if len(edge.Docs) > 1 {
			health.CrossDocumentEdges++
		}
	}
	health.Nodes = len(nodes)
	health.Edges = len(edges)
	health.MergedEntities = len(entries) - len(nodes)
	health.ConclusionRatio = conclusionRatio(health.ConclusionLinks, len(edges))

	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": nodes, "edges": edges, "papers": papers, "totalDocuments": totalDocuments,
		"stats": health,
	})
}

// handleGraphExtract 对一篇论文抽实体与带证据的关系。
//
// 纪律：AI 调用期间**不持任何锁**（180s 的出站请求不能堵住图谱读写）；
// 调完之后才在 graphMu 内 load-modify-save。
func (s *Server) handleGraphExtract(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key   string `json:"key"`
		Force bool   `json:"force"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	key, err := safeKey(strings.TrimSpace(body.Key), "论文键")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	source, err := s.sourceText(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if strings.TrimSpace(source) == "" {
		// 没有正文就没有可核验的证据来源，抽出来的东西无法回到原文。
		writeError(w, http.StatusConflict, "这篇论文还没有正文缓存，无法抽取知识图谱（证据必须能回到原文）")
		return
	}
	// AI 未配置同样 409：与「先完成前置条件再重试」的语义一致（先配置 AI 设置）。
	config, err := s.aiConfig()
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if !config.Ready() {
		writeError(w, http.StatusConflict, "还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
		return
	}

	// 幂等：已有结果且未要求重抽 → 直接回当前 paper，不调模型、不烧额度。
	// 这个短锁只覆盖读检查，不含模型调用。旧 promptVersion 的记录在 loadGraph 里已被
	// 当作空图，所以过期的记录不会让这里误判成「已抽过」。
	s.graphMu.Lock()
	existing, loadErr := s.loadGraph(r.Context())
	s.graphMu.Unlock()
	if loadErr != nil {
		writeError(w, http.StatusInternalServerError, loadErr.Error())
		return
	}
	if record, found := existing.Docs[key]; found && !body.Force {
		writeJSON(w, http.StatusOK, map[string]any{
			"skipped": true, "paper": newGraphPaper(key, record), "stats": graphStatsOf(record),
		})
		return
	}

	// 材料容量控制：全文 scope 按页序取满 50000 字符，截断时 ScopingNote 如实披露子集。
	material := ai.ScopingNote(ai.SelectWithMeta(source, "", "全文", graphMaterialLimit))
	// 不持锁调模型。
	raw, err := ai.NewClient(config).Generate(r.Context(), graphSystemPrompt(), graphUserPrompt(doc.Title, material), 0)
	if err != nil {
		writeError(w, http.StatusBadGateway, "知识图谱抽取失败: "+err.Error())
		return
	}
	record, err := parseGraphModelOutput(raw, key, doc.Title, source)
	if err != nil {
		// 解析失败：错误里带模型原文摘要（截断 200 字），否则用户只能看到「解析失败」无从排错。
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	stats := graphStatsOf(record)
	// 结论占比是提示词配额，服务端不拒绝不达标的输出，但必须让它可见（日志 + 响应 stats）。
	log.Printf("知识图谱抽取 %s（promptVersion %s）：实体 %d、关系 %d、结论 %d、"+
		"指向结论的关系 %d 条（%.0f%%）、别名合并 %d、丢弃 %d（词表外 %d / 端点缺失 %d / 证据核不过 %d）",
		key, graphPromptVersion, stats.Entities, stats.Relations, stats.Conclusions, stats.ConclusionLinks,
		stats.ConclusionRatio*100, stats.MergedEntities, stats.Dropped,
		stats.DroppedVocabulary, stats.DroppedEndpoint, stats.DroppedEvidence)

	// 调完之后才在 graphMu 内 load-modify-save。
	s.graphMu.Lock()
	defer s.graphMu.Unlock()
	graph, err := s.loadGraph(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	graph.Docs[key] = record
	if err := s.replaceGraph(r.Context(), graph); err != nil {
		writeError(w, http.StatusInternalServerError, "保存知识图谱失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"skipped": false, "paper": newGraphPaper(key, record), "stats": stats,
	})
}

// handleGraphDelete 移除一篇论文的抽取结果（图上该篇的节点/边随合并消失）。
func (s *Server) handleGraphDelete(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	s.graphMu.Lock()
	defer s.graphMu.Unlock()
	graph, err := s.loadGraph(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, found := graph.Docs[key]; !found {
		writeError(w, http.StatusNotFound, "这篇论文还没有抽取过知识图谱")
		return
	}
	delete(graph.Docs, key)
	if err := s.replaceGraph(r.Context(), graph); err != nil {
		writeError(w, http.StatusInternalServerError, "删除知识图谱抽取失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "deleted": true})
}

// ---- 提示词 ----

// graphSystemPrompt 只约束输出格式、命名纪律与证据纪律：要求「只输出 JSON」，
// 解释混进输出会让解析失败。
func graphSystemPrompt() string {
	return `你是论文知识图谱抽取器。只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 围栏。

输出格式：
{"entities":[{"label":"","kind":"concept|method|conclusion","aliases":[""]}],"relations":[{"from":"<实体 label>","to":"<实体 label>","label":"<受控关系词>","evidence":[{"page":"第 N 页","excerpt":"<逐字原文 8-200 字>"}]}]}

一、实体命名（跨文献能不能合并全靠这一步）
1. label 用领域通用规范术语，不要自造缩写、变体或口语说法：
   - 有通行译名就用通行译名：统一写「稀疏视角 CT」，不要写「少视角CT」「稀疏角CT」「sparse angle CT」；
   - 英文术语用通行拼写：统一写 "sparse-view CT"，不要写 SparseViewCT / sparse view ct；
   - 同一个东西全文只用一个 label，不要一半中文一半英文。
2. aliases 填该实体的常见别名、同义写法、中英对照（≤4 个，没有就填 []）。
   服务端把 label 与 aliases 一起归一化，归一化后完全相等即视为同一实体，所以中英对照一定要写进来。
   例：{"label":"稀疏视角 CT","kind":"concept","aliases":["sparse-view CT","limited-angle CT"]}
3. kind 只能是 concept（概念）/ method（方法）/ conclusion（结论）三选一。
4. label 简短：中文 ≤12 字，或 ≤6 个英文词。

二、关系只用受控词表（不在表内的关系会被服务端丢弃）
受控词：基于 / 使用 / 改进 / 解决 / 应用于 / 属于 / 对比 / 优于 / 支持 / 导致 / 产生 / 评估 / 包含 / 得出
- 英文一律翻成上表的中文词：based on→基于、use→使用、improve→改进、outperform→优于、evaluate→评估…
- 语义确实不在表内的关系不要硬塞，宁可不写这一条。
- from/to 必须是 entities 里出现过的 label（或其中某个 alias）。

三、结论与论证链（重点：不要只抽名词）
1. 必须抽出这篇论文自己的结论，至少 3 条 conclusion，并写成可判断的断言而不是名词：
   例「NAF 在稀疏视角下优于传统重建」「该方法以需要 50 个视角先验为代价」「该指标在低剂量下评估不可靠」。
   不要用「实验结果」「性能分析」「方法设计」这类零信息量的名词充当 conclusion。
2. 论证链优先：至少 30% 的关系要指向 conclusion（从 concept/method 出发，用「得出/导致/支持/优于/解决」等词连到某个 conclusion）。
3. 尽量形成 ≥2 跳的链条：概念 → 方法 → 结论。

四、证据纪律
1. 只抽正文里有依据的实体与关系，不许脑补。
2. 每条关系给 1-4 条证据：page 写「第 N 页」（N 必须与正文里 === Page N === 的编号一致），
   excerpt 逐字来自该页（不改一字、不跨页拼接、不加省略号）。
3. 服务端会逐字核验证据：核不过的证据会被丢弃，关系失去全部证据就不会上图。

五、上限
实体 ≤60 个、关系 ≤120 条。`
}

func graphUserPrompt(title, material string) string {
	return "论文标题：" + title +
		"\n\n请从下面的正文缓存中抽取实体与带证据的关系（【材料范围】说明了是否为子集）。\n" +
		"要求：label 用领域规范术语并写清 aliases（中英对照必填）；关系只用受控词表" +
		"（基于/使用/改进/解决/应用于/属于/对比/优于/支持/导致/产生/评估/包含/得出）；" +
		"至少 3 条 conclusion，且至少 30% 的关系指向 conclusion；" +
		"每条关系 1-4 条证据，page 写「第 N 页」，excerpt 必须逐字来自该页。\n" +
		"上限：实体 ≤60 个、关系 ≤120 条。\n\n" +
		material
}

// ---- 归一化与合并 ----

// isCJK 判断一个字符是否属于中日韩文字（不含标点）：用来在中文与拉丁/数字之间补词边界。
func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
}

// foldGraphText 把一段文本折叠成可比较的键：
// 全角转半角 → 小写 → 标点/符号/不可见字符一律当分隔符 → 中日韩文字与拉丁/数字之间补一个空格
// （「稀疏视角CT」与「稀疏视角 CT」因此可比）→ 空白压缩。
//
// 这是纯文本规则：没有编辑距离、没有词干化、没有模糊匹配、没有子串包含。跨文献合并只认
// 「折叠后完全相等」——放宽判定会造出假合并，那比漏合并更伤证据纪律（实测两篇之间 57×47
// 的组合里也只有个位数对候选，为这点收益去模糊匹配得不偿失）。
func foldGraphText(value string) string {
	var builder strings.Builder
	var previous rune
	for index, r := range value {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			// 全角 ASCII（！…～）整体平移到半角。
			r -= 0xFEE0
		case r == 0x3000:
			r = ' '
		}
		r = unicode.ToLower(r)
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			r = ' '
		}
		if index > 0 && previous != ' ' && r != ' ' && isCJK(previous) != isCJK(r) {
			builder.WriteRune(' ')
		}
		builder.WriteRune(r)
		previous = r
	}
	return strings.Join(strings.Fields(builder.String()), " ")
}

// normalizeEntityID 把 label/别名归一化成跨文献可合并的节点 id（见 foldGraphText）。
// label 本身保留原样用于展示。
func normalizeEntityID(label string) string {
	return foldGraphText(label)
}

// entityKeys 返回一个实体的全部归一化键：label 与所有 aliases 折叠后的去重结果。
// 两个实体只要有任一 key 相同，就是同一个实体。
func entityKeys(label string, aliases []string) []string {
	keys := make([]string, 0, 1+len(aliases))
	seen := map[string]bool{}
	appendKey := func(value string) {
		key := normalizeEntityID(value)
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		keys = append(keys, key)
	}
	appendKey(label)
	for _, alias := range aliases {
		appendKey(alias)
	}
	return keys
}

// cleanAliases 清洗别名列表：去首尾空白、剔除空值与重复、剔除与最终 label 同键的项（label
// 已经承担展示职责，再列一遍只是噪音），并截到 graphMaxAliases。返回的切片一定非 nil，
// 这样响应里的 aliases 是 [] 而不是 null。
func cleanAliases(values []string, finalLabel string) []string {
	cleaned := []string{}
	seen := map[string]bool{normalizeEntityID(finalLabel): true}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		key := normalizeEntityID(trimmed)
		if trimmed == "" || key == "" || seen[key] {
			continue
		}
		seen[key] = true
		cleaned = append(cleaned, trimmed)
		if len(cleaned) >= graphMaxAliases {
			break
		}
	}
	return cleaned
}

// graphEntityID 返回实体的归一化 id：落库时已经算好；手写/历史记录缺 id 时按 label 现算。
func graphEntityID(entity graphEntity) string {
	if id := strings.TrimSpace(entity.ID); id != "" {
		return id
	}
	if id := normalizeEntityID(entity.Label); id != "" {
		return id
	}
	return strings.TrimSpace(entity.Label)
}

// graphEntityEntry 是归并输入的一项：某篇文档里的一个实体（docKey 用于决定展示与 docs 顺序）。
type graphEntityEntry struct {
	DocKey string
	Entity graphEntity
}

// graphGlobalNode 是归并后的全局节点：一组被视为同一实体的 (docKey, 实体) 的合并结果。
type graphGlobalNode struct {
	ID      string
	Label   string
	Kind    string
	Aliases []string
	Docs    []string
}

// mergeGraphEntities 按「label 与 aliases 折叠成键后相交」把各篇的实体归并成全局节点，
// 并返回每个输入项所属的组下标（写入侧要靠它把关系端点改写到组 id 上）。
//
// 输入必须已按 docKey 升序、篇内按模型输出顺序铺平：组内首个出现者决定 id/label/kind
// （既有展示约定「首个出现者赢」），docs 去重升序，aliases 取全组并集并剔除与最终 label
// 同键的项。判定只用「折叠后完全相等」，不做子串/编辑距离之类的模糊匹配。
func mergeGraphEntities(entries []graphEntityEntry) ([]graphGlobalNode, []int) {
	nodes := []graphGlobalNode{}
	groupOfEntry := make([]int, len(entries))
	indexByKey := map[string]int{}
	for position, entry := range entries {
		keys := entityKeys(entry.Entity.Label, entry.Entity.Aliases)
		match := -1
		for _, key := range keys {
			if index, ok := indexByKey[key]; ok {
				match = index
				break
			}
		}
		if match < 0 {
			label := strings.TrimSpace(entry.Entity.Label)
			nodes = append(nodes, graphGlobalNode{
				ID: graphEntityID(entry.Entity), Label: label, Kind: entry.Entity.Kind,
				Aliases: cleanAliases(entry.Entity.Aliases, label),
				Docs:    []string{entry.DocKey},
			})
			match = len(nodes) - 1
		} else {
			node := &nodes[match]
			if !hasString(node.Docs, entry.DocKey) {
				node.Docs = append(node.Docs, entry.DocKey)
			}
			// 被并进来的 label 本身也是别名候选：两篇各写一个中英 label 时，全局节点要把
			// 另一个 label 收进 aliases，合并才不至于丢信息。
			merged := append([]string{}, node.Aliases...)
			merged = append(merged, entry.Entity.Label)
			merged = append(merged, entry.Entity.Aliases...)
			node.Aliases = cleanAliases(merged, node.Label)
		}
		groupOfEntry[position] = match
		for _, key := range keys {
			if _, ok := indexByKey[key]; !ok {
				indexByKey[key] = match
			}
		}
	}
	return nodes, groupOfEntry
}

// ---- 解析与核验 ----

// graphRawSnippet 把模型原文截断后放进错误信息：原文可能几十 KB，但排错需要看到它
// 到底回了什么（围栏？散文？截断？），200 字足够定位。
func graphRawSnippet(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len([]rune(trimmed)) > 200 {
		return string([]rune(trimmed)[:200]) + "…"
	}
	return trimmed
}

// graphPageNumber 把模型给的页码解码成页码数字：提示词要求写「第 N 页」这样的枚举，
// 数字形式（2）也照收——两种写法都能回到同一页，形式不该成为丢关系的理由。
// 非数字/非字符串（布尔、对象、数组）仍然是类型错误，由调用方 502；
// 拿不到数字时返回 nil，交给逐字核验判失败。
func graphPageNumber(value any) (*int, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case float64:
		page := int(typed)
		return &page, nil
	case string:
		digits := ""
		for _, r := range typed {
			if r >= '0' && r <= '9' {
				digits += string(r)
				continue
			}
			if digits != "" {
				break
			}
		}
		if digits == "" {
			return nil, nil
		}
		page, err := strconv.Atoi(digits)
		if err != nil {
			return nil, nil
		}
		return &page, nil
	default:
		return nil, fmt.Errorf("evidence.page 类型非法：%T（应为「第 N 页」或数字）", value)
	}
}

// parseGraphModelOutput 按冻结契约的顺序处理模型输出，任何整体失败都不落库：
// JSON 可解析 → kind 白名单与必填 label（非法即整份 502）→ label/aliases 相交归并实体
// → 关系 label 映射到受控词表（表外丢弃并计入 dropped）→ from/to 映射到实体（找不到则丢弃）
// → 逐条 evidence 过 ValidateIdeaEvidence（失败丢该条计入 dropped）
// → 关系的 evidence 全丢则丢关系计入 dropped → 实体/关系数量上限截断 → 落库。
func parseGraphModelOutput(raw, key, title, source string) (graphDocExtraction, error) {
	reject := func(reason string) (graphDocExtraction, error) {
		return graphDocExtraction{}, fmt.Errorf("AI 返回的知识图谱无法解析（%s）；原文摘要：%s",
			reason, graphRawSnippet(raw))
	}
	payload := ai.ExtractJSONObject(raw)
	var decoded graphModelOutput
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		return reject("模型输出不是合法 JSON: " + err.Error())
	}

	// kind 白名单与必填 label：非法即拒绝整个抽取结果——半份记录进库会让图谱无法解释。
	knownKinds := map[string]bool{"concept": true, "method": true, "conclusion": true}
	for index, entity := range decoded.Entities {
		label := strings.TrimSpace(entity.Label)
		if label == "" {
			return reject(fmt.Sprintf("第 %d 个实体缺少 label", index+1))
		}
		if !knownKinds[entity.Kind] {
			return reject(fmt.Sprintf("第 %d 个实体的 kind 非法：%q（只能是 concept/method/conclusion）",
				index+1, entity.Kind))
		}
		if normalizeEntityID(label) == "" {
			return reject(fmt.Sprintf("实体 %q 归一化后没有可用 id", label))
		}
	}
	for index, relation := range decoded.Relations {
		if strings.TrimSpace(relation.Label) == "" {
			return reject(fmt.Sprintf("第 %d 条关系缺少 label", index+1))
		}
	}

	// 实体：label 与 aliases 一起折成键，相交即同一实体。同篇内就在这里并掉（跨篇在 GET 里
	// 用同一个函数再并一次），因此「稀疏视角CT」与别名相交的「Sparse-View CT」不会留成两个节点。
	entries := make([]graphEntityEntry, 0, len(decoded.Entities))
	for _, entity := range decoded.Entities {
		entries = append(entries, graphEntityEntry{
			DocKey: key,
			Entity: graphEntity{
				ID: normalizeEntityID(entity.Label), Label: strings.TrimSpace(entity.Label),
				Kind: entity.Kind, Aliases: cleanAliases(entity.Aliases, entity.Label),
			},
		})
	}
	merged, groupOfEntry := mergeGraphEntities(entries)
	entities := make([]graphEntity, 0, len(merged))
	for _, node := range merged {
		entities = append(entities, graphEntity{
			ID: node.ID, Label: node.Label, Kind: node.Kind, Aliases: node.Aliases,
		})
	}
	// 端点解析表：label 与 alias 都能指回组 id（模型拿别名当端点也认）。
	idByKey := map[string]string{}
	for position, entry := range entries {
		groupID := merged[groupOfEntry[position]].ID
		for _, candidateKey := range entityKeys(entry.Entity.Label, entry.Entity.Aliases) {
			if _, ok := idByKey[candidateKey]; !ok {
				idByKey[candidateKey] = groupID
			}
		}
	}

	droppedVocabulary := 0
	droppedEndpoint := 0
	droppedEvidence := 0

	// 关系：先过受控词表，再映射端点，最后逐条核验证据。
	relations := make([]graphRelation, 0, len(decoded.Relations))
	for index, relation := range decoded.Relations {
		label, ok := normalizeRelationLabel(relation.Label)
		if !ok {
			// 词表外的关系丢弃并计入 dropped（不是整份 502）：措辞跑偏一条，不值得废掉整篇。
			droppedVocabulary++
			continue
		}
		from, fromOK := idByKey[normalizeEntityID(relation.From)]
		to, toOK := idByKey[normalizeEntityID(relation.To)]
		if !fromOK || !toOK {
			// 端点找不到 → 丢关系，计入 dropped（不算整体失败）。
			droppedEndpoint++
			continue
		}
		kept := []graphEvidence{}
		for _, item := range relation.Evidence {
			page, err := graphPageNumber(item.Page)
			if err != nil {
				return reject(fmt.Sprintf("第 %d 条关系的证据页码非法: %v", index+1, err))
			}
			evidence := validate.IdeaEvidence{
				Origin: validate.OriginPaperText, PaperKey: key, Page: page, Excerpt: item.Excerpt,
			}
			if err := validate.ValidateIdeaEvidence(evidence, source); err != nil {
				// 证据核不过 → 丢这一条，计入 dropped。
				droppedEvidence++
				continue
			}
			kept = append(kept, graphEvidence{Page: *page, Excerpt: item.Excerpt})
		}
		if len(kept) == 0 {
			// 没有任何可回到原文的证据 → 这条关系不能上图。
			droppedEvidence++
			continue
		}
		relations = append(relations, graphRelation{
			From: from, To: to, Label: label, Evidence: kept,
		})
	}

	// 数量上限截断：按模型输出顺序取前 N（截断不计 dropped）。
	if len(entities) > graphMaxEntities {
		entities = entities[:graphMaxEntities]
	}
	// 实体被截断后，指向已删实体的边必须一并静默移除，否则图上会出现悬空端点。
	keptIDs := make(map[string]bool, len(entities))
	for _, entity := range entities {
		keptIDs[entity.ID] = true
	}
	trimmed := relations[:0]
	for _, relation := range relations {
		if keptIDs[relation.From] && keptIDs[relation.To] {
			trimmed = append(trimmed, relation)
		}
	}
	relations = trimmed
	if len(relations) > graphMaxRelations {
		relations = relations[:graphMaxRelations]
	}

	dropped := droppedVocabulary + droppedEndpoint + droppedEvidence
	return graphDocExtraction{
		Title: title, ExtractedAt: nowStamp(),
		Entities: entities, Relations: relations, Dropped: dropped,
		Stats: graphExtractionStats{
			MergedEntities:    len(entries) - len(merged),
			DroppedVocabulary: droppedVocabulary,
			DroppedEndpoint:   droppedEndpoint,
			DroppedEvidence:   droppedEvidence,
		},
	}, nil
}

// normalizeRelationLabel 把模型给的关系 label 映射到受控词表；不在词表内返回 ("", false)，
// 由调用方丢弃该关系并计入 dropped。容忍全角/半角、大小写、包含空格的写法与英文同义词。
func normalizeRelationLabel(label string) (string, bool) {
	stem := foldGraphText(label)
	if stem == "" {
		return "", false
	}
	if canonical, ok := graphRelationStems[stem]; ok {
		return canonical, true
	}
	if canonical, ok := graphRelationAliases[stem]; ok {
		return canonical, true
	}
	return "", false
}

// conclusionRatio 返回「指向 conclusion 的关系」占比，没有关系时为 0。
func conclusionRatio(links, relations int) float64 {
	if relations <= 0 {
		return 0
	}
	return float64(links) / float64(relations)
}

// graphStatsOf 从落库记录重算统计：可推导的字段（实体/关系/结论计数与占比）一律现算，
// 免得旧记录里存着过时的数字；只有丢弃原因明细取自记录本身，没有明细的旧记录把差额
// 记进 droppedOther，保证 dropped 总数始终可解释。
func graphStatsOf(record graphDocExtraction) graphStats {
	kindByID := map[string]string{}
	stats := graphStats{Entities: len(record.Entities), Relations: len(record.Relations), Dropped: record.Dropped}
	for _, entity := range record.Entities {
		kindByID[entity.ID] = entity.Kind
		if entity.Kind == "conclusion" {
			stats.Conclusions++
		}
	}
	for _, relation := range record.Relations {
		if kindByID[relation.To] == "conclusion" {
			stats.ConclusionLinks++
		}
	}
	stats.MergedEntities = record.Stats.MergedEntities
	stats.DroppedVocabulary = record.Stats.DroppedVocabulary
	stats.DroppedEndpoint = record.Stats.DroppedEndpoint
	stats.DroppedEvidence = record.Stats.DroppedEvidence
	if other := record.Dropped - stats.DroppedVocabulary - stats.DroppedEndpoint - stats.DroppedEvidence; other > 0 {
		stats.DroppedOther = other
	}
	stats.ConclusionRatio = conclusionRatio(stats.ConclusionLinks, stats.Relations)
	stats.ConclusionQuotaMet = stats.ConclusionRatio >= graphConclusionQuota
	return stats
}

// ---- 数据访问 ----

// loadGraph 读 app_state['knowledge-graph']。
//
// 版本门：记录里的 promptVersion 与当前 graphPromptVersion 不一致（含旧记录缺该字段）时，
// 整份图谱按「没抽过」返回空图——旧提示词抽出的实体名与关系词表都不满足当前契约，展示出来
// 只会误导；同时 POST extract 的幂等检查看到空图自然会重抽。刻意不删除旧数据本身：
// 重抽成功时由 replaceGraph 覆盖同一把 key。
func (s *Server) loadGraph(ctx context.Context) (*knowledgeGraph, error) {
	var body string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, graphStateKey).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return newKnowledgeGraph(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取知识图谱失败: %w", err)
	}
	stored := knowledgeGraph{}
	if err := json.Unmarshal([]byte(body), &stored); err != nil {
		// 损坏时报错而不是返回空图：返回空会让下一次写入覆盖已有的全部抽取结果。
		return nil, fmt.Errorf("知识图谱数据已损坏（app_state.%s 不是 JSON 对象）: %w", graphStateKey, err)
	}
	if stored.PromptVersion != graphPromptVersion {
		return newKnowledgeGraph(), nil
	}
	if stored.Docs == nil {
		stored.Docs = map[string]graphDocExtraction{}
	}
	return &stored, nil
}

// replaceGraph 写入整份图谱。promptVersion 由这里统一盖章（不依赖调用方记得设置），
// 保证落库的记录一定是当前契约版本。
func (s *Server) replaceGraph(ctx context.Context, graph *knowledgeGraph) error {
	graph.PromptVersion = graphPromptVersion
	encoded, err := json.Marshal(graph)
	if err != nil {
		return err
	}
	_, err = s.handle.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		graphStateKey, string(encoded), nowStamp())
	return err
}

func hasString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// Package catalog 移植旧版 windows/src/core/systemTags.ts：系统标签的关键词派生。
//
// 移植纪律（逐条对应 TS 注释里的「刻意不做 X」）：
//   - 只做「文本里确实出现」的关键词匹配，命不中就是空，绝不推测；
//   - 每个线索数组的顺序参与语义：TS 用 cues.first(where:) 取第一个命中词，
//     evidence 记录的是数组里第一个命中的线索，而不是文本里最先出现的那个；
//   - 匹配是子串包含，不是词边界匹配（"supervised" 会命中 "self-supervised"）。
package catalog

import "strings"

// SystemTagCategories 顺序即 TS 的 SYSTEM_TAG_CATEGORIES，derive 的输出顺序依赖它。
var SystemTagCategories = []string{
	"Task",
	"Domain",
	"Acquisition",
	"Architecture",
	"Learning Paradigm",
	"Dataset",
	"Metric",
	"Venue",
}

// SystemTag 与 TS SystemTag 对应。
type SystemTag struct {
	Category string `json:"category"`
	Value    string `json:"value"`
	// Evidence 是命中的原文关键词，用于「为什么有这个标签」核对。
	Evidence string `json:"evidence"`
}

// vocabulary：键是展示用标签值，值是该标签的同义线索（全部小写）。
// 顺序参与语义，见包注释。
var vocabulary = map[string]map[string][]string{
	"Task": {
		"Sparse-view":           {"sparse-view", "sparse view", "few-view", "few view", "limited-angle"},
		"Low-dose":              {"low-dose", "low dose", "low-mas", "low mas", "dose reduction"},
		"4D-CBCT":               {"4d-cbct", "4d cbct", "dynamic cbct", "motion"},
		"Artifact Removal":      {"artifact", "artefact", "metal artifact", "scatter correction"},
		"Projection Completion": {"projection completion", "sinogram completion", "inpainting"},
		"Super-resolution":      {"super-resolution", "super resolution", "superresolution"},
	},
	"Domain": {
		"Projection":  {"sinogram", "projection domain", "raw projection"},
		"Image":       {"image domain", "image-domain", "post-processing"},
		"Dual-domain": {"dual-domain", "dual domain"},
		"Implicit 3D": {"implicit", "neural field", "neural radiance", "attenuation field"},
	},
	"Acquisition": {
		"Circular":      {"circular", "full-scan", "360"},
		"Limited-angle": {"limited-angle", "limited angle", "45°", "limited angular"},
		"Real scan":     {"real data", "real-world", "patient", "clinical"},
		"Simulated":     {"simulated", "simulation", "tigre", "synthetic"},
	},
	"Architecture": {
		"CNN":         {"convolutional", "cnn", "u-net", "unet"},
		"Transformer": {"transformer", "attention", "vit"},
		"MLP":         {"mlp", "multi-layer perceptron", "multilayer perceptron"},
		"Diffusion":   {"diffusion", "score-based", "denoising diffusion"},
		"Gaussian":    {"gaussian splatting", "3d gaussian", "gaussian representation"},
		"Hash Grid":   {"hash encoding", "hash grid", "instant-ngp", "multiresolution hash"},
	},
	"Learning Paradigm": {
		"Supervised":            {"supervised", "ground truth supervision"},
		"Self-supervised":       {"self-supervised", "self supervised", "unsupervised", "without training data"},
		"Per-case Optimization": {"per-case", "per case", "per-subject", "per-patient"},
		"Test-time Adaptation":  {"test-time", "test time", "scan-adaptive", "tta"},
	},
	"Dataset": {
		"Walnut":       {"walnut"},
		"LUNA16":       {"luna16", "luna-16"},
		"AAPM":         {"aapm", "low dose ct grand challenge"},
		"LIDC-IDRI":    {"lidc", "lidc-idri"},
		"TIGRE":        {"tigre"},
		"Real Phantom": {"phantom"},
	},
	"Metric": {
		"PSNR":  {"psnr", "peak signal-to-noise"},
		"SSIM":  {"ssim", "structural similarity"},
		"RMSE":  {"rmse", "root mean square"},
		"MAE":   {"mae", "mean absolute error"},
		"LPIPS": {"lpips"},
	},
	"Venue": {
		"MICCAI":                        {"miccai"},
		"CVPR":                          {"cvpr"},
		"ICCV":                          {"iccv"},
		"ECCV":                          {"eccv"},
		"NeurIPS":                       {"neurips", "nips"},
		"IEEE TMI":                      {"ieee transactions on medical imaging", "tmi"},
		"Medical Physics":               {"medical physics"},
		"Physics in Medicine & Biology": {"physics in medicine"},
	},
}

// Derive 从可检索文本片段派生系统标签，与 TS derive 逐条一致：
// 所有字段用空格 join 后整体 lowercase 再做 contains 匹配（跨字段拼接可产生假命中，
// 这是既有语义，移植不改）；按类别顺序、类内按 value 字典序遍历；用 category|value 去重。
func Derive(fields []string) []SystemTag {
	haystack := strings.ToLower(strings.Join(fields, " "))
	if haystack == "" {
		return []SystemTag{}
	}
	out := []SystemTag{}
	seen := map[string]bool{}
	for _, category := range SystemTagCategories {
		values := vocabulary[category]
		if values == nil {
			continue
		}
		for _, label := range sortedKeys(values) {
			hit, found := firstHit(values[label], haystack)
			if !found {
				continue
			}
			id := category + "|" + label
			if seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, SystemTag{Category: category, Value: label, Evidence: hit})
		}
	}
	return out
}

// Coverage 与 TS coverage 一致：给出每类的命中数，供 UI 显示「哪些类别没有证据」。
func Coverage(tags []SystemTag) []struct {
	Category string
	Count    int
} {
	out := make([]struct {
		Category string
		Count    int
	}, 0, len(SystemTagCategories))
	for _, category := range SystemTagCategories {
		count := 0
		for _, tag := range tags {
			if tag.Category == category {
				count++
			}
		}
		out = append(out, struct {
			Category string
			Count    int
		}{category, count})
	}
	return out
}

// TagFields 与 TS tagFields 一致：只收集队列条目自身携带的文本。
// 字段顺序影响 join 结果（进而影响跨字段边界的子串命中），因此顺序照抄 TS。
func TagFields(title, abstract, venue, why string) []string {
	fields := []string{}
	for _, value := range []string{title, abstract, venue, why} {
		if value != "" {
			fields = append(fields, value)
		}
	}
	return fields
}

func firstHit(cues []string, haystack string) (string, bool) {
	for _, cue := range cues {
		if strings.Contains(haystack, cue) {
			return cue, true
		}
	}
	return "", false
}

// sortedKeys 复刻 JS Object.keys(...).sort()：按 UTF-16 code unit 字典序。
// 标签值都是 ASCII 或常见中文，Go 的字节序对 BMP 内字符与 UTF-16 序一致。
func sortedKeys(values map[string][]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	// 简单插入排序：标签数量很小，避免引入 sort 的额外比较语义差异。
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

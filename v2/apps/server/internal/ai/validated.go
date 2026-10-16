package ai

import (
	"context"
	"fmt"

	"cbctv2/server/internal/validate"
)

// ValidatedOutcome 是「生成 + 自动修正重试 + 终局降级轮」的结果。
//
// ValidationError 非空表示多轮之后仍未通过证据校验：调用方（readings 写入路径）
// 再走本地修剪层，修剪也救不回才按「未核验」保存并留下原因。
type ValidatedOutcome struct {
	Value           string
	ValidationError string
	Attempts        int
}

// GenerateValidated 对应旧版 generateValidated。
// 实测失败主因是模型合并事实/漏数组字段——看到具体错误后大多能自行改对，所以把校验错误原样回喂。
func GenerateValidated(ctx context.Context, client *Client, kind, system, source string, maxRepairs int) (ValidatedOutcome, error) {
	return GenerateValidatedWithProgress(ctx, client, kind, system, source, maxRepairs, nil)
}

// GenerateValidatedWithProgress reports work as it moves through model generation and evidence validation.
func GenerateValidatedWithProgress(ctx context.Context, client *Client, kind, system, source string, maxRepairs int, progress func(stage string, attempt, maxAttempts int)) (ValidatedOutcome, error) {
	outcome := ValidatedOutcome{}
	value := ""
	validationError := ""

	for attempt := 0; attempt <= maxRepairs; attempt++ {
		outcome.Attempts = attempt + 1
		if progress != nil {
			stage := "generating"
			if attempt > 0 {
				stage = "repairing"
			}
			progress(stage, attempt+1, maxRepairs+2)
		}
		userMessage := FirstInstruction(kind)
		if attempt > 0 {
			userMessage = RepairInstruction(kind, validationError, value)
		}
		generated, err := client.Generate(ctx, system, userMessage, 0.2)
		if err != nil {
			return outcome, err
		}
		value = generated
		if progress != nil {
			progress("validating", attempt+1, maxRepairs+2)
		}
		if !JSONKinds[kind] {
			outcome.Value = value
			return outcome, nil
		}
		if validateErr := validate.ValidateGenerated(kind, value, source); validateErr == nil {
			outcome.Value = value
			outcome.ValidationError = ""
			return outcome, nil
		} else {
			validationError = validateErr.Error()
		}
	}

	// 终局降级轮：顽固字段（PDF 文本抽取错乱导致逐字摘录无法命中）反复修正也过不去。
	if validationError != "" {
		outcome.Attempts++
		if progress != nil {
			progress("downgrading", outcome.Attempts, maxRepairs+2)
		}
		generated, err := client.Generate(ctx, system, DowngradeInstruction(validationError), 0.2)
		if err != nil {
			return outcome, err
		}
		value = generated
		if progress != nil {
			progress("validating", outcome.Attempts, maxRepairs+2)
		}
		if validateErr := validate.ValidateGenerated(kind, value, source); validateErr == nil {
			outcome.Value = value
			outcome.ValidationError = ""
			return outcome, nil
		} else {
			validationError = validateErr.Error()
		}
	}

	outcome.Value = value
	outcome.ValidationError = validationError
	if outcome.Value == "" {
		return outcome, fmt.Errorf("模型没有返回内容")
	}
	return outcome, nil
}

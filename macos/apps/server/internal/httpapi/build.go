package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"sync"
)

// buildFingerprint 是当前二进制的 SHA-256：启动器用它判断「正在跑的后端」
// 是否还是同一份构建。
//
// 为什么不用版本号或启动时间：开发态反复 rebuild，版本号不会变；启动时间只能
// 说明新旧，不能说明是不是同一份。内容指纹唯一对应一份可执行文件，重建后必然
// 变化，正是启动器需要的信号。
//
// 可执行文件在 20 MB 量级，哈希一次几十毫秒；用 sync.OnceValue 保证整个进程
// 只算一次，也不会拖慢健康检查。
var buildFingerprint = sync.OnceValue(func() string {
	executable, err := os.Executable()
	if err != nil {
		return "unknown"
	}
	body, err := os.ReadFile(executable)
	if err != nil {
		return "unknown"
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
})

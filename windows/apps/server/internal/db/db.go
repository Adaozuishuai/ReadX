// Package db 打开 SQLite、施加运行期 pragma，并按内嵌迁移文件建表。
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

const driverName = "sqlite"

// pragmas 在 Open 后立刻施加。因为连接池被限制为单连接（见下），一次 exec 即对整个
// 进程生命周期生效，不依赖驱动特有的 DSN 语法。
var pragmas = []string{
	`PRAGMA journal_mode = WAL`,
	`PRAGMA synchronous = NORMAL`,
	`PRAGMA busy_timeout = 5000`,
	`PRAGMA foreign_keys = ON`,
}

// Open 建目录 → 打开 → pragma → 迁移。返回的句柄可直接使用。
func Open(ctx context.Context, path string) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("数据库路径为空")
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建数据目录失败: %w", err)
		}
	}
	handle, err := sql.Open(driverName, "file:"+filepath.ToSlash(path))
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	// 单连接：SQLite 上 pragma 是每连接的，连接池会让 pragma 与写并发都难以推理；
	// 本地单机应用的吞吐远不需要多连接。
	handle.SetMaxOpenConns(1)

	if err := handle.PingContext(ctx); err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}
	for _, pragma := range pragmas {
		if _, err := handle.ExecContext(ctx, pragma); err != nil {
			_ = handle.Close()
			return nil, fmt.Errorf("%s 执行失败: %w", pragma, err)
		}
	}
	if err := Migrate(ctx, handle); err != nil {
		_ = handle.Close()
		return nil, err
	}
	return handle, nil
}

type migration struct {
	version int
	name    string
}

// Migrate 幂等：已记录的版本号跳过，未应用的按序在事务内执行。
func Migrate(ctx context.Context, handle *sql.DB) error {
	if _, err := handle.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT NOT NULL,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return fmt.Errorf("创建迁移记录表失败: %w", err)
	}

	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return fmt.Errorf("读取内嵌迁移失败: %w", err)
	}
	var list []migration
	seen := map[int]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, err := parseVersion(entry.Name())
		if err != nil {
			return err
		}
		if dup, ok := seen[version]; ok {
			return fmt.Errorf("迁移版本号重复：%s 与 %s", dup, entry.Name())
		}
		seen[version] = entry.Name()
		list = append(list, migration{version: version, name: entry.Name()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].version < list[j].version })

	for _, m := range list {
		var applied int
		if err := handle.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, m.version).Scan(&applied); err != nil {
			return fmt.Errorf("查询迁移状态失败: %w", err)
		}
		if applied > 0 {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + m.name)
		if err != nil {
			return fmt.Errorf("读取迁移 %s 失败: %w", m.name, err)
		}
		tx, err := handle.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("开启迁移事务失败: %w", err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("迁移 %s 失败: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)`,
			m.version, m.name, time.Now().UTC().Format(time.RFC3339)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("记录迁移 %s 失败: %w", m.name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("提交迁移 %s 失败: %w", m.name, err)
		}
	}
	return nil
}

// Version 返回已应用的最高版本号，供健康/元信息接口上报。
func Version(ctx context.Context, handle *sql.DB) (int, error) {
	var version sql.NullInt64
	if err := handle.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	if !version.Valid {
		return 0, nil
	}
	return int(version.Int64), nil
}

// parseVersion 从 "0001_init.sql" 取出 1。
func parseVersion(name string) (int, error) {
	cut := strings.IndexByte(name, '_')
	if cut <= 0 {
		return 0, fmt.Errorf("迁移文件名需形如 0001_name.sql，实际 %q", name)
	}
	version, err := strconv.Atoi(name[:cut])
	if err != nil || version <= 0 {
		return 0, fmt.Errorf("迁移版本号非法：%q", name)
	}
	return version, nil
}

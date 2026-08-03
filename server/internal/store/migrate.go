package store

import (
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
)

//go:embed migrations/*.sql
var embedded embed.FS

// A variable so tests can substitute a deliberately broken set.
var migrations fs.FS = embedded

const migrationsDir = "migrations"

const createSchemaMigrations = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version    TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
)`

func (db *DB) migrate() error {
	if _, err := db.Exec(createSchemaMigrations); err != nil {
		return fmt.Errorf("creating schema_migrations: %w", err)
	}

	versions, err := migrationVersions()
	if err != nil {
		return err
	}

	for _, version := range versions {
		applied, err := db.isApplied(version)
		if err != nil {
			return err
		}
		if applied {
			continue
		}
		if err := db.apply(version); err != nil {
			return err
		}
		slog.Info("migration applied", "version", version)
	}

	return nil
}

func migrationVersions() ([]string, error) {
	entries, err := fs.ReadDir(migrations, migrationsDir)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", migrationsDir, err)
	}

	versions := make([]string, 0, len(entries))
	for _, entry := range entries {
		versions = append(versions, entry.Name())
	}
	sort.Strings(versions)

	return versions, nil
}

func (db *DB) isApplied(version string) (bool, error) {
	var count int
	err := db.QueryRow("SELECT count(*) FROM schema_migrations WHERE version = ?", version).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("checking %s: %w", version, err)
	}

	return count > 0, nil
}

// The migration and the row recording it share a transaction, so a failure
// leaves neither behind.
func (db *DB) apply(version string) error {
	statements, err := fs.ReadFile(migrations, migrationsDir+"/"+version)
	if err != nil {
		return fmt.Errorf("reading %s: %w", version, err)
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin %s: %w", version, err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(string(statements)); err != nil {
		return fmt.Errorf("applying %s: %w", version, err)
	}
	if _, err := tx.Exec(
		"INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
		version,
	); err != nil {
		return fmt.Errorf("recording %s: %w", version, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing %s: %w", version, err)
	}

	return nil
}

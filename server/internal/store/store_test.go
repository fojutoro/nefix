package store

import (
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openTemp(t *testing.T) *DB {
	t.Helper()

	db, err := Open(filepath.Join(t.TempDir(), "nefix.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	return db
}

func TestOpenCreatesSchema(t *testing.T) {
	db := openTemp(t)

	for _, table := range []string{"institutions", "faculties", "notes", "schema_migrations"} {
		t.Run(table, func(t *testing.T) {
			var name string
			err := db.QueryRow(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table,
			).Scan(&name)
			if err != nil {
				t.Errorf("table %s missing: %v", table, err)
			}
		})
	}
}

func TestOpenRecordsEveryMigration(t *testing.T) {
	db := openTemp(t)

	want, err := migrationVersions()
	if err != nil {
		t.Fatalf("migrationVersions: %v", err)
	}

	rows, err := db.Query("SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		t.Fatalf("querying schema_migrations: %v", err)
	}
	defer rows.Close()

	var got []string
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			t.Fatalf("scanning version: %v", err)
		}
		got = append(got, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating: %v", err)
	}

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("applied = %v, want %v", got, want)
	}
}

func TestOpenTwiceIsNoOp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nefix.db")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	first.Close()

	// A second Open re-running the migrations would fail on CREATE TABLE.
	second, err := Open(path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer second.Close()

	want, err := migrationVersions()
	if err != nil {
		t.Fatalf("migrationVersions: %v", err)
	}

	var count int
	if err := second.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatalf("counting migrations: %v", err)
	}
	if count != len(want) {
		t.Errorf("schema_migrations has %d rows, want %d", count, len(want))
	}
}

func TestForeignKeysEnforced(t *testing.T) {
	db := openTemp(t)

	_, err := db.Exec(
		"INSERT INTO faculties (institution_id, name) VALUES (?, ?)", 999, "Nonexistent",
	)
	if err == nil {
		t.Fatal("insert with an unknown institution_id succeeded; foreign_keys is not on")
	}
}

func TestPragmas(t *testing.T) {
	db := openTemp(t)

	tests := []struct {
		pragma string
		want   string
	}{
		{"journal_mode", "wal"},
		{"foreign_keys", "1"},
		{"busy_timeout", "5000"},
		{"synchronous", "1"},
	}

	for _, tt := range tests {
		t.Run(tt.pragma, func(t *testing.T) {
			var got string
			if err := db.QueryRow("PRAGMA " + tt.pragma).Scan(&got); err != nil {
				t.Fatalf("PRAGMA %s: %v", tt.pragma, err)
			}
			if got != tt.want {
				t.Errorf("%s = %q, want %q", tt.pragma, got, tt.want)
			}
		})
	}
}

func TestMalformedMigrationRollsBack(t *testing.T) {
	good, err := fs.ReadFile(embedded, migrationsDir+"/0001_init.sql")
	if err != nil {
		t.Fatalf("reading embedded migration: %v", err)
	}

	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, migrationsDir), 0o755); err != nil {
		t.Fatalf("creating migrations dir: %v", err)
	}
	write := func(name string, content []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, migrationsDir, name), content, 0o644); err != nil {
			t.Fatalf("writing %s: %v", name, err)
		}
	}
	write("0001_init.sql", good)
	write("0002_bad.sql", []byte("CREATE TABLE halfway (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;\n"))

	original := migrations
	migrations = os.DirFS(dir)
	t.Cleanup(func() { migrations = original })

	path := filepath.Join(t.TempDir(), "nefix.db")
	_, err = Open(path)
	if err == nil {
		t.Fatal("Open succeeded despite a malformed migration")
	}
	if !strings.Contains(err.Error(), "0002_bad.sql") {
		t.Errorf("error does not name the file: %v", err)
	}

	// Reopened raw, because Open would re-run the failing migration.
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	defer raw.Close()

	var name string
	err = raw.QueryRow(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'halfway'",
	).Scan(&name)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("table halfway survived, so the failed migration partially applied (err = %v)", err)
	}

	applied := func(version string) int {
		t.Helper()
		var count int
		if err := raw.QueryRow(
			"SELECT count(*) FROM schema_migrations WHERE version = ?", version,
		).Scan(&count); err != nil {
			t.Fatalf("counting %s: %v", version, err)
		}
		return count
	}

	if got := applied("0002_bad.sql"); got != 0 {
		t.Errorf("0002_bad.sql recorded %d times, want 0", got)
	}
	// 0001 committed in its own transaction and must survive.
	if got := applied("0001_init.sql"); got != 1 {
		t.Errorf("0001_init.sql recorded %d times, want 1", got)
	}
}

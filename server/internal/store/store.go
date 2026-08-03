package store

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

// foreign_keys is off by default in SQLite and is per-connection, so the
// REFERENCES clauses in the schema do nothing without it.
var pragmas = []string{
	"journal_mode=WAL",
	"busy_timeout=5000",
	"foreign_keys=ON",
	"synchronous=NORMAL",
}

func Open(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}

	// SQLite serialises writes anyway, and one connection removes a whole
	// category of locking bug. It also means the per-connection pragmas
	// below are set once rather than per pooled connection.
	sqlDB.SetMaxOpenConns(1)

	for _, pragma := range pragmas {
		if _, err := sqlDB.Exec("PRAGMA " + pragma); err != nil {
			sqlDB.Close()
			return nil, fmt.Errorf("pragma %s: %w", pragma, err)
		}
	}

	db := &DB{sqlDB}
	if err := db.migrate(); err != nil {
		sqlDB.Close()
		return nil, err
	}

	return db, nil
}

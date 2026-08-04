package store

import (
	"context"
	"errors"
	"testing"
)

func createUser(t *testing.T, db *DB, username, email string) *User {
	t.Helper()

	user, err := db.CreateUser(context.Background(), username, "Display Name", email, "not-a-real-hash")
	if err != nil {
		t.Fatalf("CreateUser(%q, %q): %v", username, email, err)
	}

	return user
}

func TestCreateAndFetchUser(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()

	created := createUser(t, db, "jozef", "jozef@example.sk")
	if created.ID == 0 {
		t.Error("created user has no id")
	}
	if created.Role != "student" {
		t.Errorf("role = %q, want %q", created.Role, "student")
	}
	if created.FacultyID != nil {
		t.Errorf("faculty_id = %v, want nil", *created.FacultyID)
	}
	if created.CreatedAt == "" {
		t.Error("created_at is empty")
	}

	byEmail, err := db.UserByEmail(ctx, "jozef@example.sk")
	if err != nil {
		t.Fatalf("UserByEmail: %v", err)
	}
	if byEmail.ID != created.ID {
		t.Errorf("UserByEmail id = %d, want %d", byEmail.ID, created.ID)
	}

	byID, err := db.UserByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("UserByID: %v", err)
	}
	if byID.Email != created.Email {
		t.Errorf("UserByID email = %q, want %q", byID.Email, created.Email)
	}
}

func TestCreateUserDuplicate(t *testing.T) {
	tests := []struct {
		name            string
		username, email string
	}{
		{"duplicate email", "different", "jozef@example.sk"},
		{"duplicate username", "jozef", "different@example.sk"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := openTemp(t)
			createUser(t, db, "jozef", "jozef@example.sk")

			_, err := db.CreateUser(context.Background(), tt.username, "Display Name", tt.email, "hash")
			if !errors.Is(err, ErrDuplicate) {
				t.Errorf("error = %v, want %v", err, ErrDuplicate)
			}
		})
	}
}

func TestEmailAndUsernameAreNormalised(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()

	created := createUser(t, db, "  Jozef  ", "  Mixed.Case@Example.SK ")
	if created.Email != "mixed.case@example.sk" {
		t.Errorf("stored email = %q, want %q", created.Email, "mixed.case@example.sk")
	}
	if created.Username != "jozef" {
		t.Errorf("stored username = %q, want %q", created.Username, "jozef")
	}

	found, err := db.UserByEmail(ctx, "mixed.case@example.sk")
	if err != nil {
		t.Fatalf("UserByEmail with the other spelling: %v", err)
	}
	if found.ID != created.ID {
		t.Errorf("found id = %d, want %d", found.ID, created.ID)
	}

	_, err = db.CreateUser(ctx, "someoneelse", "Display Name", "Mixed.Case@Example.SK", "hash")
	if !errors.Is(err, ErrDuplicate) {
		t.Errorf("inserting the same email differently cased: error = %v, want %v", err, ErrDuplicate)
	}
}

func TestUserNotFound(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()

	if _, err := db.UserByEmail(ctx, "nobody@example.sk"); !errors.Is(err, ErrNotFound) {
		t.Errorf("UserByEmail error = %v, want %v", err, ErrNotFound)
	}
	if _, err := db.UserByID(ctx, 12345); !errors.Is(err, ErrNotFound) {
		t.Errorf("UserByID error = %v, want %v", err, ErrNotFound)
	}
}

func TestUpdatePasswordHash(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()

	created := createUser(t, db, "jozef", "jozef@example.sk")

	if err := db.UpdatePasswordHash(ctx, created.ID, "a-different-hash"); err != nil {
		t.Fatalf("UpdatePasswordHash: %v", err)
	}

	updated, err := db.UserByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("UserByID: %v", err)
	}
	if updated.PasswordHash != "a-different-hash" {
		t.Errorf("password_hash = %q, want %q", updated.PasswordHash, "a-different-hash")
	}

	if err := db.UpdatePasswordHash(ctx, 12345, "hash"); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdatePasswordHash on an unknown id: error = %v, want %v", err, ErrNotFound)
	}
}

package password

import (
	"errors"
	"strings"
	"testing"
)

const plain = "correct horse battery staple"

func TestHashVerifyRoundTrip(t *testing.T) {
	encoded, err := Hash(plain)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}

	ok, _, err := Verify(encoded, plain)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !ok {
		t.Error("the right password did not verify")
	}

	ok, _, err = Verify(encoded, "wrong password")
	if err != nil {
		t.Fatalf("Verify with wrong password: %v", err)
	}
	if ok {
		t.Error("the wrong password verified")
	}
}

func TestHashIsSalted(t *testing.T) {
	first, err := Hash(plain)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	second, err := Hash(plain)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}

	if first == second {
		t.Error("two hashes of the same password are identical, so the salt is not random")
	}
}

func TestHashRejectsEmptyPassword(t *testing.T) {
	if _, err := Hash(""); !errors.Is(err, ErrEmptyPassword) {
		t.Errorf("Hash(\"\") error = %v, want %v", err, ErrEmptyPassword)
	}
}

func TestEncodedShape(t *testing.T) {
	encoded, err := Hash(plain)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}

	prefix := "$argon2id$v=19$m=65536,t=3,p=2$"
	if !strings.HasPrefix(encoded, prefix) {
		t.Errorf("encoded = %q, want prefix %q", encoded, prefix)
	}

	got, salt, key, err := parse(encoded)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got != Default {
		t.Errorf("parsed params = %+v, want %+v", got, Default)
	}
	if len(salt) != int(Default.SaltLen) {
		t.Errorf("salt is %d bytes, want %d", len(salt), Default.SaltLen)
	}
	if len(key) != int(Default.KeyLen) {
		t.Errorf("key is %d bytes, want %d", len(key), Default.KeyLen)
	}
}

func TestNeedsRehash(t *testing.T) {
	weaker := Default
	weaker.Memory = 32768

	tests := []struct {
		name   string
		params Params
		want   bool
	}{
		{"default parameters", Default, false},
		{"different memory", weaker, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded, err := hashWith(tt.params, plain)
			if err != nil {
				t.Fatalf("hashWith: %v", err)
			}

			ok, needsRehash, err := Verify(encoded, plain)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if !ok {
				t.Fatal("password did not verify")
			}
			if needsRehash != tt.want {
				t.Errorf("needsRehash = %v, want %v", needsRehash, tt.want)
			}
		})
	}
}

func TestVerifyMalformed(t *testing.T) {
	valid, err := Hash(plain)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	fields := strings.Split(valid, "$")

	tests := []struct {
		name    string
		encoded string
	}{
		{"empty", ""},
		{"no dollars", "notahash"},
		{"too few fields", "$argon2id$v=19$m=65536,t=3,p=2$" + fields[4]},
		{"too many fields", valid + "$extra"},
		{"unknown algorithm", strings.Replace(valid, "$argon2id$", "$argon2i$", 1)},
		{"wrong version", strings.Replace(valid, "v=19", "v=16", 1)},
		{"unreadable version", strings.Replace(valid, "v=19", "version", 1)},
		{"unreadable parameters", strings.Replace(valid, "m=65536,t=3,p=2", "m=lots", 1)},
		{"bad base64 salt", "$argon2id$v=19$m=65536,t=3,p=2$not!base64$" + fields[5]},
		{"bad base64 key", "$argon2id$v=19$m=65536,t=3,p=2$" + fields[4] + "$not!base64"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ok, needsRehash, err := Verify(tt.encoded, plain)
			if err == nil {
				t.Fatal("malformed input did not return an error")
			}
			if ok || needsRehash {
				t.Errorf("ok = %v, needsRehash = %v, want false, false", ok, needsRehash)
			}
		})
	}
}

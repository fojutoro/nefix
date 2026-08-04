// Package password hashes and verifies passwords with argon2id.
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

type Params struct {
	Memory  uint32
	Time    uint32
	Threads uint8
	SaltLen uint32
	KeyLen  uint32
}

// OWASP's baseline. Memory is allocated per hash, so concurrent logins each
// take 64 MiB for the duration of the derivation.
var Default = Params{Memory: 65536, Time: 3, Threads: 2, SaltLen: 16, KeyLen: 32}

const (
	algorithm = "argon2id"
	version   = 19
)

var (
	ErrEmptyPassword = errors.New("password: empty password")
	ErrMalformed     = errors.New("password: malformed encoded hash")
)

func Hash(plain string) (string, error) {
	return hashWith(Default, plain)
}

func hashWith(p Params, plain string) (string, error) {
	if plain == "" {
		return "", ErrEmptyPassword
	}

	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password: reading salt: %w", err)
	}

	key := argon2.IDKey([]byte(plain), salt, p.Time, p.Memory, p.Threads, p.KeyLen)

	return fmt.Sprintf("$%s$v=%d$m=%d,t=%d,p=%d$%s$%s",
		algorithm, version, p.Memory, p.Time, p.Threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// Verify derives with the parameters stored in encoded, not with Default, so
// a hash made under older parameters still verifies after Default changes.
// needsRehash is only meaningful when ok is true.
func Verify(encoded, plain string) (ok bool, needsRehash bool, err error) {
	p, salt, want, err := parse(encoded)
	if err != nil {
		return false, false, err
	}

	got := argon2.IDKey([]byte(plain), salt, p.Time, p.Memory, p.Threads, p.KeyLen)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return false, false, nil
	}

	return true, p != Default, nil
}

func parse(encoded string) (Params, []byte, []byte, error) {
	var none Params

	// Leading empty field, algorithm, version, parameters, salt, key.
	fields := strings.Split(encoded, "$")
	if len(fields) != 6 {
		return none, nil, nil, fmt.Errorf("%w: got %d fields, want 6", ErrMalformed, len(fields))
	}
	if fields[1] != algorithm {
		return none, nil, nil, fmt.Errorf("%w: algorithm %q", ErrMalformed, fields[1])
	}

	var v int
	if _, err := fmt.Sscanf(fields[2], "v=%d", &v); err != nil {
		return none, nil, nil, fmt.Errorf("%w: unreadable version %q", ErrMalformed, fields[2])
	}
	if v != version {
		return none, nil, nil, fmt.Errorf("%w: version %d, want %d", ErrMalformed, v, version)
	}

	var p Params
	if _, err := fmt.Sscanf(fields[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Time, &p.Threads); err != nil {
		return none, nil, nil, fmt.Errorf("%w: unreadable parameters %q", ErrMalformed, fields[3])
	}

	salt, err := base64.RawStdEncoding.DecodeString(fields[4])
	if err != nil {
		return none, nil, nil, fmt.Errorf("%w: salt: %v", ErrMalformed, err)
	}
	key, err := base64.RawStdEncoding.DecodeString(fields[5])
	if err != nil {
		return none, nil, nil, fmt.Errorf("%w: key: %v", ErrMalformed, err)
	}

	p.SaltLen = uint32(len(salt))
	p.KeyLen = uint32(len(key))

	return p, salt, key, nil
}

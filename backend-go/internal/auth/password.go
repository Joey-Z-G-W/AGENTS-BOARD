package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/scrypt"
)

var (
	ErrPasswordInput = errors.New("password must be admin for local preview or contain 12–256 characters")
	ErrPasswordBusy  = errors.New("password verification capacity reached")
)

const passwordPrefix = "scrypt$131072$8$1$"

type Passwords struct {
	active chan struct{}
}

func NewPasswords() *Passwords {
	return &Passwords{active: make(chan struct{}, 2)}
}

func (passwords *Passwords) Hash(ctx context.Context, password string) (string, error) {
	length := utf8.RuneCountInString(password)
	if !utf8.ValidString(password) || length > 256 || (password != "admin" && length < 12) {
		return "", ErrPasswordInput
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	digest, err := passwords.derive(ctx, password, salt)
	if err != nil {
		return "", err
	}
	return passwordPrefix + hex.EncodeToString(salt) + "$" + hex.EncodeToString(digest), nil
}

func (passwords *Passwords) Verify(ctx context.Context, password, encoded string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if !utf8.ValidString(password) || len(password) > 1024 || utf8.RuneCountInString(password) > 256 {
		return false, nil
	}
	if len(encoded) != len(passwordPrefix)+32+1+128 || !strings.HasPrefix(encoded, passwordPrefix) {
		return false, nil
	}
	parts := strings.Split(strings.TrimPrefix(encoded, passwordPrefix), "$")
	if len(parts) != 2 || len(parts[0]) != 32 || len(parts[1]) != 128 {
		return false, nil
	}
	salt, saltErr := hex.DecodeString(parts[0])
	expected, digestErr := hex.DecodeString(parts[1])
	if saltErr != nil || digestErr != nil || hex.EncodeToString(salt) != parts[0] || hex.EncodeToString(expected) != parts[1] {
		return false, nil
	}
	digest, err := passwords.derive(ctx, password, salt)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(digest, expected) == 1, nil
}

func (passwords *Passwords) derive(ctx context.Context, password string, salt []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case passwords.active <- struct{}{}:
		defer func() { <-passwords.active }()
	default:
		return nil, ErrPasswordBusy
	}
	digest, err := scrypt.Key([]byte(password), salt, 131072, 8, 1, 64)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return digest, nil
}

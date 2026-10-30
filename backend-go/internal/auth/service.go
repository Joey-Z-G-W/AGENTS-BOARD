package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"
	"unicode/utf8"

	api "agents-board/backend-go/internal/api/generated"
)

var ErrCredentials = errors.New("invalid credentials")
var ErrCapacity = errors.New("token capacity reached")

type Service struct {
	mu             sync.Mutex
	passwords      *Passwords
	username, hash string
	tokens         map[[32]byte]time.Time
	now            func() time.Time
}

func NewService(ctx context.Context, username, password string, now func() time.Time) (*Service, error) {
	if username == "" || !utf8.ValidString(username) || utf8.RuneCountInString(username) > 64 {
		return nil, ErrCredentials
	}
	if now == nil {
		now = time.Now
	}
	passwords := NewPasswords()
	hash, err := passwords.Hash(ctx, password)
	if err != nil {
		return nil, err
	}
	return &Service{passwords: passwords, username: username, hash: hash, tokens: map[[32]byte]time.Time{}, now: now}, nil
}
func (s *Service) Login(ctx context.Context, username, password string) (api.TokenResponse, error) {
	valid, err := s.passwords.Verify(ctx, password, s.hash)
	if err != nil {
		return api.TokenResponse{}, err
	}
	if subtle.ConstantTimeCompare([]byte(username), []byte(s.username)) != 1 || !valid {
		return api.TokenResponse{}, ErrCredentials
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for digest, expiry := range s.tokens {
		if !expiry.After(now) {
			delete(s.tokens, digest)
		}
	}
	if len(s.tokens) >= 128 {
		return api.TokenResponse{}, ErrCapacity
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return api.TokenResponse{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	expiry := now.Add(time.Hour)
	s.tokens[sha256.Sum256([]byte(token))] = expiry
	return api.TokenResponse{AccessToken: token, ExpiresAt: expiry, TokenType: api.Bearer}, nil
}
func (s *Service) Valid(token string) bool {
	if len(token) != 43 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	digest := sha256.Sum256([]byte(token))
	expiry, ok := s.tokens[digest]
	if ok && !expiry.After(s.now()) {
		delete(s.tokens, digest)
		return false
	}
	return ok
}
func (s *Service) Logout(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tokens, sha256.Sum256([]byte(token)))
}

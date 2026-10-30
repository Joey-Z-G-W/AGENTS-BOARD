package auth

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestTokenLifecycle(t *testing.T) {
	now := time.Now()
	s, err := NewService(context.Background(), "admin", "admin", func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	token, err := s.Login(context.Background(), "admin", "admin")
	if err != nil || !s.Valid(token.AccessToken) {
		t.Fatal("login failed", err)
	}
	s.Logout(token.AccessToken)
	if s.Valid(token.AccessToken) {
		t.Fatal("revoked token accepted")
	}
	token, err = s.Login(context.Background(), "admin", "admin")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	if s.Valid(token.AccessToken) {
		t.Fatal("expired token accepted")
	}
	if _, err = s.Login(context.Background(), "wrong", "admin"); err != ErrCredentials {
		t.Fatal("wrong username accepted")
	}
}
func TestUsernameContract(t *testing.T) {
	for _, username := range []string{"", strings.Repeat("a", 65), string([]byte{255})} {
		if _, err := NewService(context.Background(), username, "admin", nil); err == nil {
			t.Fatal("invalid username accepted")
		}
	}
}

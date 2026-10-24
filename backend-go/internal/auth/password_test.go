package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestPasswordHashAndVerification(t *testing.T) {
	passwords := NewPasswords()
	ctx := context.Background()
	password := "test-only-long-password"
	first, err := passwords.Hash(ctx, password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := passwords.Hash(ctx, password)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || strings.Contains(first, password) || !strings.HasPrefix(first, passwordPrefix) {
		t.Fatal("hashes must use independent salts and the established encoded format")
	}
	valid, err := passwords.Verify(ctx, password, first)
	if err != nil || !valid {
		t.Fatalf("correct password rejected: %v", err)
	}
	valid, err = passwords.Verify(ctx, "incorrect", first)
	if err != nil || valid {
		t.Fatalf("incorrect password accepted or errored: %v", err)
	}
}

func TestLocalPreviewPassword(t *testing.T) {
	passwords := NewPasswords()
	encoded, err := passwords.Hash(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	valid, err := passwords.Verify(context.Background(), "admin", encoded)
	if err != nil || !valid {
		t.Fatalf("explicit preview password rejected: %v", err)
	}
}

func TestNodePasswordHashCompatibility(t *testing.T) {
	encoded := passwordPrefix + "000102030405060708090a0b0c0d0e0f$" +
		"9d8d2242efa12ed2e3452e6bcecae218fdeba285acef31d45643a3fb3ba59a4731a374c57e42f57df140372ccb660ad8bf800cfc8761875be9c55ceff3829a3f"
	valid, err := NewPasswords().Verify(context.Background(), "migration-test-password", encoded)
	if err != nil || !valid {
		t.Fatalf("Node scrypt compatibility fixture rejected: %v", err)
	}
}

func TestPasswordInputAndMalformedHashes(t *testing.T) {
	passwords := NewPasswords()
	ctx := context.Background()
	for _, password := range []string{"", "short", strings.Repeat("a", 257), string([]byte{0xff})} {
		if _, err := passwords.Hash(ctx, password); !errors.Is(err, ErrPasswordInput) {
			t.Fatal("invalid startup password was not rejected")
		}
	}
	for _, encoded := range []string{
		"broken",
		"scrypt$2$8$1$" + strings.Repeat("a", 32) + "$" + strings.Repeat("b", 128),
		passwordPrefix + strings.Repeat("a", 31) + "$" + strings.Repeat("b", 129),
		passwordPrefix + strings.Repeat("z", 32) + "$" + strings.Repeat("b", 128),
		passwordPrefix + strings.Repeat("A", 32) + "$" + strings.Repeat("b", 128),
		passwordPrefix + strings.Repeat("a", 32) + "$" + strings.Repeat("b", 128) + "$extra",
	} {
		valid, err := passwords.Verify(ctx, "admin", encoded)
		if err != nil || valid {
			t.Fatalf("malformed hash must fail without running expensive derivation: %v", err)
		}
	}
	valid, err := passwords.Verify(ctx, strings.Repeat("a", 257), passwordPrefix+strings.Repeat("a", 32)+"$"+strings.Repeat("b", 128))
	if err != nil || valid {
		t.Fatal("oversized verification input must be rejected")
	}
}

func TestPasswordCapacityAndCancellation(t *testing.T) {
	passwords := NewPasswords()
	passwords.active <- struct{}{}
	passwords.active <- struct{}{}
	if _, err := passwords.Hash(context.Background(), "admin"); !errors.Is(err, ErrPasswordBusy) {
		t.Fatal("must reject work beyond the shared instance capacity")
	}
	<-passwords.active
	<-passwords.active
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := passwords.Hash(ctx, "admin"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled hash must not start")
	}
	if _, err := passwords.Verify(ctx, "admin", "broken"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled verification must not start")
	}
	if len(passwords.active) != 0 {
		t.Fatal("failed operations must not retain capacity")
	}
}

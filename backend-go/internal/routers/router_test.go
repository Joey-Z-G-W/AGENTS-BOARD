package routers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"agents-board/backend-go/internal/api/generated"
)

func TestHealth(t *testing.T) {
	router, err := New()
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body)
	}
	var health generated.Health
	if err := json.Unmarshal(response.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.Status != generated.Ok || health.Mode != generated.InMemoryDemo {
		t.Fatalf("unexpected health: %+v", health)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("health must not be cached")
	}
}

func TestFoundationDoesNotExposeBusinessRoutes(t *testing.T) {
	router, err := New()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/health", "/api/dashboard", "/api/hosts"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d", path, response.Code)
		}
	}
}

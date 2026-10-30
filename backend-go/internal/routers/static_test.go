package routers

import (
	"agents-board/backend-go/internal/auth"
	"agents-board/backend-go/internal/store"
	"context"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestStaticAndAPIBoundaries(t *testing.T) {
	credentials, err := auth.NewService(context.Background(), "admin", "admin", nil)
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewApplication(&Application{Store: store.Demo(nil), Auth: credentials}, nil)
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>fixture</title>")}, "assets/app.js": &fstest.MapFile{Data: []byte("fixture")}}
	if err = MountWeb(router, files); err != nil {
		t.Fatal(err)
	}
	for path, status := range map[string]int{"/": 200, "/assets/app.js": 200, "/assets/missing.js": 404, "/api/missing": 404, "/assets/": 404, "/../secret": 404} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:3003"+path, nil))
		if w.Code != status {
			t.Errorf("%s = %d want %d", path, w.Code, status)
		}
	}
	for path, status := range map[string]int{"/": 200, "/api/health": 403, "/api/dashboard": 403} {
		request := httptest.NewRequest("GET", "http://127.0.0.1:3003"+path, nil)
		request.Header.Set("Sec-Fetch-Site", "cross-site")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, request)
		if w.Code != status {
			t.Fatalf("external navigation %s = %d want %d", path, w.Code, status)
		}
	}
}

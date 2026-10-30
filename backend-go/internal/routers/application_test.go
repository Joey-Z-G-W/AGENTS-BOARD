package routers

import (
	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/auth"
	"agents-board/backend-go/internal/store"
	"context"
	"encoding/json"
	"github.com/getkin/kin-openapi/openapi3"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestApplicationContractAndAuth(t *testing.T) {
	credentials, err := auth.NewService(context.Background(), "admin", "admin", nil)
	if err != nil {
		t.Fatal(err)
	}
	app := &Application{Store: store.Demo(time.Now), Auth: credentials}
	router, err := NewApplication(app, []string{"http://127.0.0.1:3003"})
	if err != nil {
		t.Fatal(err)
	}
	token := ""
	request := func(method, path, body, origin string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "http://127.0.0.1:3003"+path, strings.NewReader(body))
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	check := func(w *httptest.ResponseRecorder, status int, schema string) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status %d != %d: %s", w.Code, status, w.Body)
		}
		if schema != "" {
			spec, _ := api.GetSwagger()
			var value any
			if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
				t.Fatal(err)
			}
			if err := spec.Components.Schemas[schema].Value.VisitJSON(value, openapi3.EnableJSONSchema2020()); err != nil {
				t.Fatalf("invalid %s: %v", schema, err)
			}
		}
	}
	check(request("GET", "/api/health", "", ""), 200, "Health")
	check(request("GET", "/api/dashboard", "", ""), 401, "Error")
	check(request("GET", "/api/health", "", "https://evil.example"), 403, "Error")
	check(request("POST", "/api/auth/login", `{"username":"admin","password":null}`, ""), 400, "Error")
	login := request("POST", "/api/auth/login", `{"username":"admin","password":"admin"}`, "")
	check(login, 200, "TokenResponse")
	var response api.TokenResponse
	_ = json.Unmarshal(login.Body.Bytes(), &response)
	token = response.AccessToken
	dashboard := request("GET", "/api/dashboard", "", "")
	check(dashboard, 200, "Dashboard")
	check(request("GET", "/api/dashboard?includeHistory=true", "", ""), 200, "Dashboard")
	check(request("GET", "/api/dashboard?includeHistory=false", "", ""), 200, "Dashboard")
	check(request("GET", "/api/dashboard?includeHistory=invalid", "", ""), 400, "Error")
	var d api.Dashboard
	_ = json.Unmarshal(dashboard.Body.Bytes(), &d)
	if len(d.Projects) != 1 {
		t.Fatal("missing demo")
	}
	s := d.Projects[0].Sessions[0]
	check(request("GET", "/api/hosts", "", ""), 200, "HostSettings")
	check(request("POST", "/api/sessions/"+s.Id+"/read", `{"turnId":"wrong"}`, ""), 409, "Error")
	check(request("POST", "/api/sessions/"+s.Id+"/read", `{"turnId":"`+store.Get(s.TurnId)+`"}`, ""), 200, "Session")
	check(request("POST", "/api/hosts", `{"target":"demo-host"}`, ""), 201, "Host")
	check(request("POST", "/api/hosts", `{"target":"demo-host","extra":true}`, ""), 400, "Error")
	check(request("POST", "/api/refresh", "", ""), 503, "Error")
	check(request("POST", "/api/auth/logout", "", ""), 204, "")
	check(request("GET", "/api/dashboard", "", ""), 401, "Error")
}
func TestAuthority(t *testing.T) {
	for _, value := range []string{"example.com", "127.0.0.1.evil", "localhost@evil", "localhost:0", "localhost:65536", "localhost:", "[::1]"} {
		if validHost(value) {
			t.Errorf("accepted %s", value)
		}
	}
	for _, value := range []string{"127.0.0.1", "localhost:3003", "[::1]:3003"} {
		if !validHost(value) {
			t.Errorf("rejected %s", value)
		}
	}
}
func TestBadHostRejectedBeforeAuth(t *testing.T) {
	credentials, _ := auth.NewService(context.Background(), "admin", "admin", nil)
	router, err := NewApplication(&Application{Store: store.New(api.InMemoryDemo, nil), Auth: credentials}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "http://evil.example/api/health", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

package routers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"agents-board/backend-go/internal/api/generated"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/gin-gonic/gin"
)

type contractStub struct {
	generated.StrictServerInterface
}

func (contractStub) Login(context.Context, generated.LoginRequestObject) (generated.LoginResponseObject, error) {
	return generated.Login401JSONResponse{Code: generated.INVALIDCREDENTIALS, Message: "Fixture only"}, nil
}

func (contractStub) Refresh(context.Context, generated.RefreshRequestObject) (generated.RefreshResponseObject, error) {
	return generated.Refresh204Response{}, nil
}

func (contractStub) RequestSessionRefresh(_ context.Context, request generated.RequestSessionRefreshRequestObject) (generated.RequestSessionRefreshResponseObject, error) {
	var job generated.RefreshJob
	err := json.Unmarshal([]byte(`{"id":"job","sessionId":"session","status":"queued","requestedAt":"2026-10-24T02:30:00Z","startedAt":null,"finishedAt":null,"expiresAt":null,"collectionVersion":null,"error":null}`), &job)
	job.SessionId = request.Id
	return generated.RequestSessionRefresh202JSONResponse{Body: job}, err
}

func TestGeneratedGinRoutesAndValidation(t *testing.T) {
	validator, err := Validator(func(context.Context, *openapi3filter.AuthenticationInput) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.UseRawPath = true
	router.Use(validator)
	generated.RegisterHandlersWithOptions(router, StrictHandler(contractStub{}), generated.GinServerOptions{BaseURL: "/api"})
	tests := []struct {
		path, body string
		status     int
	}{
		{"/api/auth/login", `{"username":"admin","password":"admin"}`, 401},
		{"/api/auth/login", `{"username":"admin"}`, 400},
		{"/api/auth/login", `{"username":"admin","password":null}`, 400},
		{"/api/auth/login", `{"username":"admin","password":"admin","extra":true}`, 400},
		{"/api/auth/login", `{"username":"admin","password":"admin"} {}`, 400},
		{"/api/refresh", "", 204},
		{"/api/sessions/session/refresh", "", 202},
		{"/api/sessions/host%2Fsession%20one/refresh", "", 202},
		{"/refresh", "", 404},
	}
	for _, test := range tests {
		t.Run(test.path+test.body, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			if test.body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d; body = %s", response.Code, response.Body)
			}
			if test.status == 204 && response.Body.Len() != 0 {
				t.Fatalf("204 must be empty: %s", response.Body)
			}
			if test.status == 202 {
				var job generated.RefreshJob
				if err := json.Unmarshal(response.Body.Bytes(), &job); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(test.path, "%2F") && job.SessionId != "host/session one" {
					t.Fatalf("opaque id changed: %q", job.SessionId)
				}
			}
			if test.status >= 400 {
				var failure generated.Error
				if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || failure.Code == "" || failure.Message == "" {
					t.Fatalf("error envelope missing: %s", response.Body)
				}
			}
		})
	}
}

func TestValidatorErrorMapping(t *testing.T) {
	validator, err := Validator(func(ctx context.Context, input *openapi3filter.AuthenticationInput) error {
		if input.RequestValidationInput.Request.Header.Get("Authorization") != "Bearer fixture" {
			return errors.New("fixture rejects credentials")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(validator)
	generated.RegisterHandlersWithOptions(router, StrictHandler(contractStub{}), generated.GinServerOptions{BaseURL: "/api"})
	tests := []struct {
		name, path, body, mediaType, bearer string
		status                              int
		code                                generated.ErrorCode
	}{
		{"missing token", "/api/refresh", "", "", "", 401, generated.UNAUTHORIZED},
		{"wrong token", "/api/refresh", "", "", "Bearer wrong", 401, generated.UNAUTHORIZED},
		{"wrong media", "/api/auth/login", `{}`, "text/plain", "", 415, generated.INVALIDREQUEST},
		{"oversized", "/api/auth/login", strings.Repeat(" ", 16385), "application/json", "", 413, generated.INVALIDREQUEST},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", test.mediaType)
			request.Header.Set("Authorization", test.bearer)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			var failure generated.Error
			if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
				t.Fatal(err)
			}
			if response.Code != test.status || failure.Code != test.code {
				t.Fatalf("status=%d, body=%s", response.Code, response.Body)
			}
			if test.status == 401 && response.Header().Get("WWW-Authenticate") != "Bearer" {
				t.Fatal("missing authentication challenge")
			}
		})
	}
}

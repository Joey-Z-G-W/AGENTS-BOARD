package routers

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/auth"
	"agents-board/backend-go/internal/store"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// Refresher is owned by the service lifetime, not by individual HTTP requests.
type Refresher interface {
	Refresh() error
	Request(string) (api.RefreshJob, error)
	Job(string) (api.RefreshJob, error)
	Changed(string)
}
type Application struct {
	Store     *store.Memory
	Auth      *auth.Service
	Refresher Refresher
}

var _ api.StrictServerInterface = (*Application)(nil)

func (a *Application) Login(ctx context.Context, r api.LoginRequestObject) (api.LoginResponseObject, error) {
	if r.Body == nil || r.Body.Password == nil {
		return nil, store.Failure(400, api.INVALIDREQUEST, "用户名和密码必填。")
	}
	token, err := a.Auth.Login(ctx, r.Body.Username, *r.Body.Password)
	if errors.Is(err, auth.ErrCredentials) {
		return nil, store.Failure(401, api.INVALIDCREDENTIALS, "用户名或密码错误。")
	}
	if errors.Is(err, auth.ErrPasswordBusy) || errors.Is(err, auth.ErrCapacity) {
		return nil, store.Failure(429, api.RATELIMITED, "登录繁忙，请稍后重试。")
	}
	return api.Login200JSONResponse(token), err
}
func (a *Application) Logout(ctx context.Context, _ api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	token, _ := ctx.Value("board.token").(string)
	a.Auth.Logout(token)
	return api.Logout204Response{}, nil
}
func (a *Application) Health(context.Context, api.HealthRequestObject) (api.HealthResponseObject, error) {
	return api.Health200JSONResponse{Status: api.Ok, Mode: a.Store.Mode()}, nil
}
func (a *Application) GetDashboard(_ context.Context, r api.GetDashboardRequestObject) (api.GetDashboardResponseObject, error) {
	return api.GetDashboard200JSONResponse(a.Store.Dashboard(r.Params.IncludeHistory != nil && *r.Params.IncludeHistory)), nil
}
func (a *Application) GetHosts(context.Context, api.GetHostsRequestObject) (api.GetHostsResponseObject, error) {
	return api.GetHosts200JSONResponse(a.Store.Hosts()), nil
}
func (a *Application) GetSession(_ context.Context, r api.GetSessionRequestObject) (api.GetSessionResponseObject, error) {
	s, err := a.Store.Session(r.Id)
	return api.GetSession200JSONResponse(s), err
}
func (a *Application) MarkRead(_ context.Context, r api.MarkReadRequestObject) (api.MarkReadResponseObject, error) {
	s, err := a.Store.Read(r.Id, r.Body.TurnId)
	return api.MarkRead200JSONResponse(s), err
}
func (a *Application) AddHost(_ context.Context, r api.AddHostRequestObject) (api.AddHostResponseObject, error) {
	h, err := a.Store.AddHost(r.Body.Target)
	if err == nil && a.Refresher != nil {
		a.Refresher.Changed(h.Id)
	}
	return api.AddHost201JSONResponse(h), err
}
func (a *Application) RemoveHost(_ context.Context, r api.RemoveHostRequestObject) (api.RemoveHostResponseObject, error) {
	err := a.Store.Remove(r.Id)
	if err == nil && a.Refresher != nil {
		a.Refresher.Changed(r.Id)
	}
	return api.RemoveHost204Response{}, err
}
func (a *Application) SetHostEnabled(_ context.Context, r api.SetHostEnabledRequestObject) (api.SetHostEnabledResponseObject, error) {
	err := a.Store.Enable(r.Id, r.Body.Enabled)
	if err == nil && a.Refresher != nil {
		a.Refresher.Changed(r.Id)
	}
	return api.SetHostEnabled204Response{}, err
}
func (a *Application) GetOpenApi(context.Context, api.GetOpenApiRequestObject) (api.GetOpenApiResponseObject, error) {
	spec, err := api.GetSwagger()
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	err = json.Unmarshal(data, &result)
	return api.GetOpenApi200JSONResponse(result), err
}
func (a *Application) Refresh(context.Context, api.RefreshRequestObject) (api.RefreshResponseObject, error) {
	if a.Refresher == nil {
		return nil, store.Failure(503, api.SERVICEUNAVAILABLE, "当前模式不支持真实刷新。")
	}
	return api.Refresh204Response{}, a.Refresher.Refresh()
}
func (a *Application) GetRefresh(_ context.Context, r api.GetRefreshRequestObject) (api.GetRefreshResponseObject, error) {
	if a.Refresher == nil {
		return nil, store.Failure(503, api.SERVICEUNAVAILABLE, "当前模式不支持真实刷新。")
	}
	job, err := a.Refresher.Job(r.Id)
	return api.GetRefresh200JSONResponse(job), err
}
func (a *Application) RequestSessionRefresh(_ context.Context, r api.RequestSessionRefreshRequestObject) (api.RequestSessionRefreshResponseObject, error) {
	if a.Refresher == nil {
		return nil, store.Failure(503, api.SERVICEUNAVAILABLE, "当前模式不支持真实刷新。")
	}
	job, err := a.Refresher.Request(r.Id)
	location := "/api/refreshes/" + url.PathEscape(job.Id)
	retry := 1
	return api.RequestSessionRefresh202JSONResponse{Body: job, Headers: api.RequestSessionRefresh202ResponseHeaders{Location: &location, RetryAfter: &retry}}, err
}

func validHost(authority string) bool {
	host := authority
	if strings.Contains(authority, ":") {
		var port string
		var err error
		host, port, err = net.SplitHostPort(authority)
		if err != nil {
			return false
		}
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return false
		}
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
func NewApplication(a *Application, origins []string) (*gin.Engine, error) {
	if a == nil || a.Auth == nil || a.Store == nil {
		return nil, errors.New("application dependencies required")
	}
	allowed := map[string]bool{}
	for _, origin := range origins {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "http" || !validHost(u.Host) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("invalid local origin")
		}
		allowed[origin] = true
	}
	validator, err := Validator(func(ctx context.Context, input *openapi3filter.AuthenticationInput) error {
		header := input.RequestValidationInput.Request.Header.Get("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok || !a.Auth.Valid(token) {
			return errors.New("unauthorized")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	router := gin.New()
	router.UseRawPath = true
	router.ContextWithFallback = true
	if err = router.SetTrustedProxies(nil); err != nil {
		return nil, err
	}
	// Loopback callers share conservative limits, bounding memory even under arbitrary URLs.
	loginLimit := rate.NewLimiter(rate.Every(12*time.Second), 5)
	requestLimit := rate.NewLimiter(rate.Limit(2), 120)
	router.Use(func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		defer func() {
			if recover() != nil {
				c.AbortWithStatusJSON(500, api.Error{Code: api.INTERNALERROR, Message: "服务内部错误。"})
			}
		}()
		isAPI := c.Request.URL.Path == "/api" || strings.HasPrefix(c.Request.URL.Path, "/api/")
		if !validHost(c.Request.Host) || isAPI && ((c.GetHeader("Origin") != "" && !allowed[c.GetHeader("Origin")]) || c.GetHeader("Sec-Fetch-Site") == "cross-site") {
			c.AbortWithStatusJSON(403, api.Error{Code: api.FORBIDDENORIGIN, Message: "只允许可信的本机请求。"})
			return
		}
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			if !requestLimit.Allow() || c.Request.URL.Path == "/api/auth/login" && !loginLimit.Allow() {
				c.Header("Retry-After", "60")
				c.AbortWithStatusJSON(429, api.Error{Code: api.RATELIMITED, Message: "请求过多，请稍后重试。"})
				return
			}
			if token, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer "); ok {
				c.Set("board.token", token)
			}
		}
		c.Next()
	})
	group := router.Group("/api")
	group.Use(validator)
	api.RegisterHandlers(group, StrictHandler(a))
	router.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, api.Error{Code: api.NOTFOUND, Message: "接口不存在。"})
	})
	return router, nil
}

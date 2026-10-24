# Go 后端基础工程

这是与 `backend/` 并存的迁移工程，不替换当前 3002 服务或 5183 前端。架构决策见根目录 `component.md`，唯一 HTTP 契约为 `../_docs/api/openapi.json`（OpenAPI 3.1.1、契约 0.4.0）。当前可运行服务仅提供 `/api/health`，没有业务接口、真实采集、后台调度或持久化；health 的 `in-memory-demo` 只表示非真实采集基础模式，不表示已提供种子看板。

## 环境与复现

使用 Go 1.26.0（本机验证版本）；依赖由 `go.mod` 和 `go.sum` 锁定。普通测试不连接真实主机，不读取原生会话，不启动常驻服务器；第一次下载依赖需要网络。

```powershell
cd backend-go
go mod download
go tool oapi-codegen -config oapi-codegen.yaml ../_docs/api/openapi.json
go test ./...
go build ./...
go run ./cmd/board
```

如果 Go 不在 PATH，Windows 可以用 `& 'C:/Program Files/Go/bin/go.exe'` 替换 `go`。服务固定监听 `127.0.0.1:3003`，不接受公网绑定；Ctrl+C 触发有界优雅关闭。本轮只运行测试与构建，没有执行最后一条启动命令。

## 工程与生成边界

- `cmd/board`：仅健康检查的程序入口、HTTP 超时与退出。
- `internal/api/generated/api.gen.go`：自动生成的 DTO、strict server 接口、Gin 绑定和嵌入契约，不手改。
- `internal/routers`：临时 health 路由、复用的契约校验与错误适配。完整业务实现接入 `RegisterHandlersWithOptions(..., BaseURL: "/api")` 时删除临时 health 注册。
- `internal/auth`：独立密码摘要模块，尚未接入登录路由或令牌系统。
- `oapi-codegen.yaml`：生成器配置，启用 `nullable-type`，不降低契约版本。

Gin、oapi-codegen、kin-openapi 等实际版本及兼容测试结果见 `../_docs/backend/go-generation.md`。生成一致性测试在临时目录重生成并逐字节比较，不改仓库生成文件。

## 明确尚未完成

认证令牌、Host/Origin 检查、限流、完整恢复处理、内存仓储、采集调度和前端切换均未完成。`Validator` 对未配置认证函数的受保护操作拒绝访问；测试中的 `contractStub` 和放行认证仅在测试文件里，绝不挂载到运行服务。

普通 `go test ./...` 已通过。当前 Windows 环境 `CGO_ENABLED=0` 且缺少 gcc/clang，`go test -race` 不能运行；这不等于 race 检查通过，也不自动安装编译器。

# Go 生成链与兼容性实测

日期：2026-10-24。输入是唯一契约 `_docs/api/openapi.json`，OpenAPI 3.1.1 / 业务契约 0.4.0；未降级为 3.0，也没有另建 Go DTO 契约。

## 已锁定版本

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Go | 1.26.0 | 本机编译与测试，go.mod 声明 |
| Gin | v1.12.0 | HTTP 路由 |
| oapi-codegen/v2 | v2.8.1 | models / gin-server / strict-server / embedded-spec |
| gin-middleware | v1.2.1 | OpenAPI 请求校验 |
| kin-openapi | v0.152.0 | OpenAPI 加载、路由匹配及 JSON Schema 2020-12 校验 |
| oapi-codegen/runtime | v1.8.0 | 生成绑定的运行时 |
| oapi-codegen/nullable | v1.1.0 | 缺失、显式 null 与非 null 的区分 |
| golang.org/x/crypto | v0.54.0 | 密码模块 scrypt |

版本由实际 Go module proxy 查询和下载确认，并锁在 `backend-go/go.mod`、`go.sum`；不只依据在线 README 宣称支持。生成命令：在 `backend-go/` 执行 `go tool oapi-codegen -config oapi-codegen.yaml ../_docs/api/openapi.json`。Go tool 指令锁定生成器依赖，无需安装全局版本。

## 已通过的兼容性检查

- 嵌入契约仍为 3.1.1，规范加载及验证通过；生成的源码可构建，临时重生成与已提交文件逐字节一致。
- JSON Schema 2020-12：string/null 联合、required nullable 缺失、错误类型、enum、const、additionalProperties=false、date-time 均有正反例。
- RefreshJob 的 if/then/else 约束：排队且空结果通过，成功状态但缺少结果与终态时间被拒绝。
- Go Nullable 的显式 null 往返不丢失，与 omitted 可区分；Go 类型本身不会拒绝缺失 required，这由契约校验负责。
- Gin 生成路由加校验器：`/api` 基路径、编码路径段（包含 `/` 与空格）、202 JSON、204 空响应、无效请求及错误 `{code,message}` 信封均通过合成 HTTP 测试。
- 缺失/错误 Bearer 经认证回调返回 401/UNAUTHORIZED 和 `WWW-Authenticate: Bearer`；这里只测试适配，尚未实现真正令牌库。
- 非 JSON 媒体类型 415、超过 16 KiB 413、尾随第二个 JSON 值 400 有回归测试。

## 实测发现与处理

1. 直接调用 `Schema.VisitJSON` 默认是旧校验模式，即使载入的文档是 3.1.1，也会漏掉 const 和 conditional 语义。测试必须显式传 `openapi3.EnableJSONSchema2020()`；kin-openapi 的 HTTP filter 会根据文档版本自动启用。不能把 Go enum 类型或生成成功当作运行时校验。
2. gin-middleware 默认把认证失败也映射成 400。薄适配包装 AuthenticationFunc，在 Gin context 记录失败，再输出契约约定的 401；不通过错误字符串猜测，不返回底层敏感错误。
3. 此组合默认接受尾随 JSON，且媒体类型错误不是约定的 415。薄适配使用标准库 `http.MaxBytesReader`、`json.Valid` 和 MIME 解析补足边界，不重新实现 JSON Schema 验证器。
4. 不透明 ID 可能包含编码斜杠。Gin 必须开启 `UseRawPath=true`，保持默认 `UnescapePathValues=true`，避免路由先把 `%2F` 变成路径分隔符；生成器最终传给 handler 的 ID 已解码一次。
5. 必填 Nullable 字段的未初始化值不等于显式 null。构造响应时用 `SetNull` / `NewNullNullable` 或从已验证 DTO 解码，不用空结构体冒充完整会话。
6. strict server 默认错误格式不是本契约的格式，因此 `routers.StrictHandler` 配置统一且脱敏的 request / handler / response 错误适配。请求校验中间件不自动为每个生产响应做完整 schema 校验；后续业务 handler 仍需响应契约测试。

## 范围和验证记录

`go test ./...`、`go build ./...` 已通过；健康检查通过真实 Gin + httptest 链路，不使用恒真测试。基础程序只暴露 health，其他接口返回 404，不把测试 stub 当成业务功能，也没有启动或切换当前预览服务。

`go test -race` 当前受本机 CGO/C 编译器缺失限制，未通过 race 验证。Host/Origin、限流、真实认证与业务接口仍在 backlog，不因已有薄校验适配而宣称完成全部安全任务。

官方依据：[oapi-codegen](https://github.com/oapi-codegen/oapi-codegen)、[gin-middleware](https://github.com/oapi-codegen/gin-middleware)、[kin-openapi](https://github.com/getkin/kin-openapi)、[Gin](https://gin-gonic.com/en/docs/)。

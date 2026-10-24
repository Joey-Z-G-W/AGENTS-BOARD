# Go 迁移接口契约

日期：2026-10-24。唯一 HTTP 契约为 `_docs/api/openapi.json`，文档版本为 0.4.0，规范仍为 OpenAPI 3.1.1。本文件解释业务语义，不建立第二套 DTO；Go 与 TypeScript 类型、路由接口和请求代码从同一契约生成。

## 实施状态与兼容边界

- 已有 TypeScript 服务支持 `in-memory-demo` 与 `real-snapshot`；新增 `continuous` 和两个作业端点是待实现协议，不表示当前预览已持续采集。旧服务可能对新增端点返回 404，客户端不得将其呈现为“已真实刷新”。
- `continuous` 仅在实际持续采集已启动后由 health 发布；关闭网页不停止后台调度，后台进程退出或宿主机休眠则无法继续。默认使用内存，重启清空采集作业、采集版本、阅读标记和令牌，不默认写入 SQLite。
- 所有旧字段的 required、null、状态枚举与错误响应保持；`Session.collectionVersion`、`Session.collectedAt` 为可选增量字段，旧 TypeScript 后端和旧样例可省略。continuous 中每个已成功采集的会话必须成对发布两字段，旧模式缺失时前端不能猜测采集版本。
- `/api` 仍是基路径；operationId 稳定；HTTP 时间均为带时区的 RFC 3339，服务端输出 UTC `Z`。路径 ID 是不透明标识，按路径段编码，不能当作文件路径或 SSH 命令。
- `GET /sessions/{id}` 只读缓存，不隐式刷新或已读；`POST /sessions/{id}/read` 仍原子比较 turnId，并要求 fresh 及已证明完成。采集版本不能替代 turnId，也不能授权把新轮次自动标为已读。
- `POST /refresh` 保留 204 无响应体，只表示接受/合并请求，不表示主机采集已成功；既有主机更新、删除和退出登录的 204 同样无响应体。

## 定向刷新端点

### POST /api/sessions/{id}/refresh

operationId 为 `requestSessionRefresh`，无请求体。仅接受服务端已知 session ID；服务端解析其存储主机、来源与读取范围，不接受用户传入命令、目录或连接参数；采集是只读操作，仍不得回写 Agent 数据库。

返回 202 和 `RefreshJob`，`Location` 指向 `/api/refreshes/{jobId}`，`Retry-After` 建议默认一秒。排队、合并都不是采集完成：同一用户同一会话只允许一个 queued/running 作业，重复请求返回同一 ID；原作业终态后再次点击才创建新作业，不复用终态成功掩盖新请求。

有界调度器按存储主机串行执行或安全合并，打开详情的定向读取优先于普通扫描。只有在该作业首次请求入队后确实读取其目标来源并成功提交对应会话，才能完成作业；之前取得的缓存、仅 SSH 连接成功、其他会话采集成功都不满足条件。已运行的后台扫描可以复用，但必须证明目标数据读取发生在首次入队之后；否则应安排下一次读取；同一作业运行期间的重复点击只合并，不承诺每次点击独立读取。

失败入口使用既有 `{code,message}` 结构：未知会话 404 `NOT_FOUND`，停用主机 409 `HOST_DISABLED`，运行模式不支持或调度器不可用 503 `SERVICE_UNAVAILABLE`，容量/频率超限 429 `RATE_LIMITED`。非空或无效请求体为 400，超限体积 413，不支持的媒体类型 415；无请求体不要求 Content-Type。

### GET /api/refreshes/{id}

operationId 为 `getRefresh`，返回 200 和作业当前状态。作业失败是查询成功的 200 + `status: failed`，不应误报为查询接口自身发生 500；GET 不触发新采集、不延长 TTL、不标已读。两个新端点都继承 Bearer、Host/Origin 和速率限制；只有发起用户能查询作业，非所属用户与不存在 ID 同样返回 404，不能凭可猜测 ID 越权获取状态。

queued -> running -> succeeded/failed；停用、删除、超时等也可以让 queued 直接终止。终态十分钟后到期并返回 404 `NOT_FOUND`，不是 410；`expiresAt` 在终态为明确时间，活动作业为 null。调度器必须有执行期限，不能用永远 running 代替失败；主机删除、服务重启可以提前移除作业，旧作业 ID 不应重用。

来源不可读取、超时或结果不合法时失败并保留旧正文、旧版本与旧成功时间；错误只能是脱敏解释，不能含原始 stderr、命令、文件路径、正文、凭据或堆栈。解析成功但没有可靠 Running/Waiting 或最终响应证据时，可以提交带 Unknown/null 的真实观察并成功结束作业，不能凭“读取成功”提高字段能力等级。文件消失但无法证明会话已删除时保留最后样本并失败，不把缺失当空会话覆盖。

## 采集版本与客户端一致性

`CollectionVersion` 是 `{epoch, sequence}`：epoch 是服务进程启动时生成的全新不透明标识；sequence 为 1 到 9007199254740991 的整数，同一会话同一 epoch 中每次成功采集提交严格递增，允许跳号。后台定时读取和定向读取均更新版本，即使内容不变；只改已读、GET 缓存、失败采集、重新生成 dashboard 不推进版本或 collectedAt。

成功读取提交必须原子发布会话内容、collectionVersion、collectedAt，之后才能将关联作业标为 succeeded 并写入相同版本。`RefreshJob.collectionVersion` 在成功时非 null，其他状态为 null；`error` 只在 failed 非 null。并发读取不能让较早结果覆盖较新结果，版本递增不能掩盖旧正文回写；具体通过单会话/主机执行互斥或提交世代检查实现。

客户端先展示缓存，再 POST 刷新并按建议间隔查询作业；succeeded 后 GET 详情，接受相同 epoch 且 sequence 大于等于作业版本的详情（可能已有后续后台采集）。若版本较小，不应回退 UI 或标已读；重新获取并按期限结束等待；若 epoch 不同，视为服务重启，丢弃旧作业/版本基线重新读取，不能跨 epoch 比较大小。接口与客户端缓存必须确保作业查询和成功后的详情重新读取不会只返回旧 HTTP 缓存。

刷新失败时保留最后样本，呈现一条可重试状态；详细采集限制折叠。成功采集时间表示“最近检查”，不等同于 Agent 最近活动或完成时间；采集成功本身也不证明 Agent 仍在运行。只有用户确实看到当前完成轮次后，才调用旧 markRead 端点，409 时重新展示新轮而不是自动已读。

## 合成协议样例

所有 ID 和时间均为合成数据，OpenAPI 内还包含可机器校验的成功、失败样例。

接受请求（202）：

```json
{"id":"refresh-synthetic-1","sessionId":"session-demo","status":"queued","requestedAt":"2026-10-24T02:30:00Z","startedAt":null,"finishedAt":null,"expiresAt":null,"collectionVersion":null,"error":null}
```

查询成功（200，读取提交后）：

```json
{"id":"refresh-synthetic-1","sessionId":"session-demo","status":"succeeded","requestedAt":"2026-10-24T02:30:00Z","startedAt":"2026-10-24T02:30:01Z","finishedAt":"2026-10-24T02:30:02Z","expiresAt":"2026-10-24T02:40:02Z","collectionVersion":{"epoch":"synthetic-boot-1","sequence":2},"error":null}
```

查询失败（200，旧快照不变）：

```json
{"id":"refresh-synthetic-1","sessionId":"session-demo","status":"failed","requestedAt":"2026-10-24T02:30:00Z","startedAt":"2026-10-24T02:30:01Z","finishedAt":"2026-10-24T02:30:02Z","expiresAt":"2026-10-24T02:40:02Z","collectionVersion":null,"error":{"code":"REFRESH_FAILED","message":"无法读取会话数据，已保留上次结果。"}}
```

过期、重启失效或未知作业（404）：

```json
{"code":"NOT_FOUND","message":"目标不存在或已失效。"}
```

## 已执行校验与后续门槛

- `openapi-spec-validator 0.7.2` 通过完整规范校验；OpenAPI 版本仍为 3.1.1。
- `jsonschema 4.26.0` Draft 2020-12 + format checker 验证了 81 个 schema/响应样例，含旧接口样例；三个不合法作业状态组合均被拒绝。
- 检查所有 204 响应均无 content；既有接口成功响应与错误结构未改变，新增 Error 枚举仅为 HOST_DISABLED、REFRESH_FAILED。
- 生成兼容性是后续独立门槛：必须对 3.1 的 null、条件 schema、严格输入、格式和枚举运行生成与校验测试；不能以能生成替代语义正确，不允许静默降到 3.0 或忽略约束。
- 新端点业务授权、TTL、取消、同会话合并、版本一致性仍需 Go 实现与自动化测试；本次只有契约及样例校验，不连接真实设备，不改变正在运行的 TypeScript 服务。

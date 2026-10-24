# Go 后端与前端精简迁移 Backlog

日期：2026-10-24。采用成熟组件与 OpenAPI 生成优先方案，目标是减少人工维护的代码，而非压缩生成文件或删除必要测试。已选择 Go 后端及模式 C：后台持续采集，关闭网页不停止采集；用户在看板打开会话时，额外触发该会话的真实刷新。本文件只规划任务，不实现代码，不修改当前运行服务。

### 范围与交接约定

- 保留现有 React / TypeScript / Vite 前端、统一 services 层及 mock；新后端暂放 `backend-go/`，与 `backend/` 并存，验收前不删除旧实现或切换当前预览端口。
- 后端固定采用 Go + Gin + oapi-codegen + 适配 Gin 的 OpenAPI 请求校验中间件；优先评估 oapi-codegen 生态的现成中间件，必须对本项目 OpenAPI 3.1.1 实际结构验证兼容性。标准库用于 context、进程控制、HTTP 服务生命周期与测试，不再手写通用路由框架、HTTP DTO 或完整 JSON Schema 校验器。
- 前端固定保留 React / TypeScript / Vite，引入 TanStack Query、Orval 和按需使用的 Ant Design；不重建整个管理后台，不引入 React-admin、go-zero、Huma 或第二套契约来源。组件只调用 services 暴露的查询与操作，生成请求与统一认证 transport 放在 services 内，现有 mock 继续支持独立演示。
- `_docs/api/openapi.json` 是唯一 HTTP 契约来源：生成 Go DTO/服务接口和 TypeScript 类型/请求函数，禁止手改生成文件或在两端重复维护同一结构。生成器、校验器与运行库锁定兼容版本；校验生成差异，错误映射和业务规则仍须测试，不把“生成成功”视为运行时校验完备。
- 建议目录为 Go 的 `cmd/board`、`internal/api/generated`、`routers`、`store`、`auth`、`collector`、`scheduler`，以及前端的 `src/services/generated`、`transport`、`queries`；仅在采集证据或内部状态确实不同于 HTTP DTO 时建立 domain 类型，不搭建通用多层框架。MSW 仅为后续条件选项，本轮先复用 mock，不同时维护第二套完整模拟系统。
- 首阶段允许复用 `backend/src/collection/probe.py` 的只读解析能力，由 Go 管理其执行；这不是继续使用 TypeScript 后端，也不是承诺纯 Go 无依赖部署。探针逐步收敛到 `backend-go/probes/`，不在远端安装 Python、守护进程、wrapper 或 hook；缺少既有运行条件时明确降级。
- 默认仍使用内存，沿用用户此前的数据存储要求；持久化只列为末尾的条件任务，未经确认不把真实正文、阅读记录或采集游标写入磁盘。后台服务运行且宿主机未休眠是持续采集的前提。
- 保持 localhost、单用户、只读 Agent 数据源边界；默认账号密码 `admin/admin` 仅限本机预览，支持环境覆盖并提示修改。禁止公网暴露、自动接受 SSH 主机密钥、保存私钥、执行 Agent 指令或回写原生会话。
- 每个编号以一次工作会话为目标，含输入路径、交付边界和验收要求；所列依赖必须先完成，但交接者无需阅读其他任务全文，可直接阅读引用的产物和测试。能力研究任务限时交付证据或明确阻塞，不要求在一次会话内破解未知格式。
- 所有实现任务均需相应自动化测试；优先合成/脱敏夹具、可替换时钟和命令执行器，普通测试不连接真实设备。真实验证仅针对已授权的本机、`t-11257`、`nb-11257`，若需要新建原生会话或制造审批/中断场景，另行确认，不将只读授权扩大为执行授权。

### 交付顺序与工具依据

先完成 Gin 首测与契约生成兼容性门槛，再迁移 API 和 services；采集器可使用协议夹具独立开发，前端可在 mock 下独立验收，最终才做真实三机验证与切换。每项任务引用的是其输入产物，编号是建议顺序而非要求必须把前面所有研究做完才可开展后续基础设施工作；研究结论可以是“未验证”，不可用字段继续降级。

根目录 `AGENTS.md` 要求成熟组件优先，其引用的 `component.md` 已记录相同架构决策；逐批实施状态、验证结果与未完成项见 `_docs/backend/go-progress.md`，本清单的任务描述不代表已经实现。相关官方资料：[Gin](https://gin-gonic.com/en/docs/)、[oapi-codegen](https://github.com/oapi-codegen/oapi-codegen)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)、[Orval](https://orval.dev/docs/guides/basics/)、[Ant Design](https://ant.design/components/overview-cn/)；实施时核对锁定版本的行为，不按社区热度推断兼容性。

代码量验收分别统计手写业务/适配代码、生成代码、测试与配置，报告删除了哪些重复实现，不预设不可靠的压缩百分比。只有库确实能承担通用能力时才引入，不为三台设备引入 Redis、微服务、ORM、分布式调度或新的认证平台。

### 事实基线与验收原则

需求输入为 `_docs/plan.md` 和本次模式 C 选择；接口输入为 `_docs/api/openapi.json`（起始契约版本 0.3.1，任务 2 已增量更新为 0.4.0），现有实现参考 `backend/src/`、`backend/tests/`、`frontend/src/services/`。研究输入为 `_docs/research/feasibility.md`、`_docs/research/evidence.json` 和较新的 `_docs/backend/real-snapshot.md`；`_docs/backend/data-gaps.md` 中早期“尚无真实采集”的陈述不能覆盖后来的单次采集结果。

2026-10-24 的真实样本为三机 41 个会话：24 条指令、6 条最终回复，7 条历史已读、34 条 Unknown；这不是完整枚举或实时生命周期证明。当前快照模式仅启动采集一次，页面刷新不重采，45 秒后 stale 不能证明机器离线；新模式不得通过更新内存时间戳伪造采集成功。

核心交付为“可独立运行的 Go 后台服务 + 有界真实采集 + 打开即刷新 + 不打扰的准确提示”。每 15 秒是默认调度间隔，不是所有设备必须 15 秒完成的承诺；来源字段与状态按验证过的能力发布，不支持的保持 null / Unknown。暂不纳入多用户、公网服务、通知、完整会话历史、远端常驻软件或原生工具查看检测的强保证。

## 1. 搭建 Gin 工程并通过首个测试
Goal: 建立可构建且有真实通过测试的最小 Go 后端。
Description: 在新目录 `backend-go/` 初始化 Go module、`cmd/board` 和 Gin router，锁定满足所选依赖要求的 Go/Gin 版本，不改动现有 `backend/`。按照 `_docs/api/openapi.json` 实现最小 `/api/health`，使用 `httptest` 通过 Gin 真实处理链断言状态码及字段，而非恒真测试；后续生成路由接管该端点时删除临时重复注册。验收为 `go test ./...` 和 `go build ./...` 通过，并在 `backend-go/README.md` 记录从干净环境复现的命令。

## 2. 固定唯一 OpenAPI 契约与会话刷新协议
Goal: 以接口文档而非重复手写模型定义迁移边界。
Description: 以 `_docs/api/openapi.json`、`backend/src/models/types.ts` 和 `frontend/src/services/types.ts` 为输入，核对 null、枚举、UTC 时间、严格输入和错误格式，更新契约但不另写 Go/TypeScript DTO。为持续模式新增明确的 `POST /sessions/{id}/refresh` 202 接受响应及 `GET /refreshes/{id}` 查询结果，定义任务身份、同会话合并、过期、失败和采集版本，保留 `POST /refresh` 的 204 仅接受语义。交付 `_docs/backend/go-contract.md`、带稳定 operationId 的 OpenAPI 及成功/失败样例，通过文档校验和旧接口差异审查，GET 详情仍不隐式已读。

## 3. 验证并接入 Go 契约生成链
Goal: 自动生成 DTO、Gin 服务接口和路由绑定，删除重复模板代码。
Description: 基于 `_docs/api/openapi.json` 在 `backend-go/` 配置锁定版本的 oapi-codegen，生成 `internal/api/generated`，选择 strict-server/Gin 支持及相匹配的请求校验中间件；以 `_docs/backend/go-contract.md` 为输入验证 3.1.1 的 null、枚举、required、additionalProperties 和 `/api` 基路径，不把代码生成等同校验。只写最薄的业务 handler 与错误适配层，通过合成请求检查非法输入、日期、204/202 及现有 `{code,message}` 响应，不能同时再维护一套 Gin binding 标签和手写 JSON Schema 校验规则。交付生成命令、版本记录和可重复生成测试，若当前组合存在语义缺口则记录阻塞并选择兼容的成熟实现，不静默降低契约版本或扩张自研校验器。

## 4. 实现线程安全的内存仓储
Goal: 为 Go 服务提供可替换且无数据竞争的状态存储。
Description: 以 `backend-go/internal/api/generated` 的契约类型和必要的内部采集状态为输入，在 `internal/store` 定义最小业务仓储接口并实现主机、项目、会话、轮次阅读标记和采集版本的内存存储，使用显式初始化而非隐式 seed。提供测试专用合成数据及可替换时钟，确保返回对象不会泄漏可变内部引用。通过并发读写测试与 `go test -race ./internal/store/...` 验证原子更新、快照一致性和进程重启后数据不保留的既定语义。

## 5. 使用成熟密码学实现登录校验
Goal: 保留密码哈希行为，不自己实现密码学算法。
Description: 参考 `backend/src/auth/password.ts`、`backend/src/auth/service.ts` 和 OpenAPI，在 `backend-go/internal/auth` 使用 `golang.org/x/crypto/scrypt` 与标准库安全随机数、恒定时间比较实现摘要封装，沿用已验证参数并限制输入与校验并发。保留本机预览默认 `admin/admin`、环境覆盖和不含秘密的弱密码提示，不引入完整用户管理平台或更换为明文验证。通过正确/错误密码、畸形摘要、超长输入和并发测试验收，记录依赖版本及参数，不保存明文。

## 6. 接入认证接口与内存 Bearer 令牌
Goal: 在生成接口之上实现小而兼容的认证业务。
Description: 使用 `backend-go/internal/auth` 的密码校验器和 `internal/api/generated` 的接口实现登录、注销与 Gin 鉴权中间件，以标准库生成随机不透明令牌，服务端只存摘要并设置到期和容量限制。令牌只存内存，退出撤销当前令牌，重启失效，401 返回约定错误和 `WWW-Authenticate`，不为减少行数引入不必要的 JWT 刷新体系。用可替换时钟测试有效、到期、撤销、错误凭据及容量边界，确认 OpenAPI 的 security 声明实际连接了鉴权而非只有文档标注。

## 7. 组合现成中间件与本地 HTTP 安全边界
Goal: 复用通用校验能力，仅手写项目特有的安全约束。
Description: 在 Gin 生成路由上接入已通过兼容性测试的 OpenAPI 校验中间件与认证中间件，复用标准库请求体限制和 `golang.org/x/time/rate` 等成熟限流组件，不再重复实现通用解析器。保留 loopback 监听、Host/Origin 检查、no-store、JSON 类型限制、尾随内容检查及统一错误适配，校验依赖未覆盖的边界必须有小而明确的补充；禁用会暴露秘密的默认请求/恢复日志。用 HTTP 表驱动测试覆盖公开/受保护端点、未知字段、跨站、超限、限流和校验错误格式，保证错误不会被默认 Gin 响应格式替换。

## 8. 迁移看板和详情读取接口
Goal: 让现有前端能通过 Go 读取相同业务数据。
Description: 使用 `backend-go/internal/store` 与 `internal/api/generated` 的服务接口实现 `/api/dashboard`、`/api/sessions/{id}` 和 `/api/hosts` 的 GET 路由，参考 `backend/src/store/memory.ts` 的排序和空值语义。保留滚动 7 天项目过滤及已读完成 24 小时隐藏，对未知时间按明确的保守策略处理，不用页面访问时间替代 Agent 活动时间。以合成仓储验证排序、边界时间、Unknown、缺失字段、404 和响应契约，测试无需任何采集器。

## 9. 迁移原子已读操作
Goal: 防止刷新或新轮次竞争导致错误标记已读。
Description: 按 `_docs/api/openapi.json`、生成服务接口和 `backend/src/store/memory.ts` 实现 `POST /api/sessions/{id}/read`，原子比较最新 turnId、完成状态和对应样本新鲜度。保持同轮重复提交幂等，以及 TURN_CHANGED、TURN_ID_UNAVAILABLE、NOT_COMPLETED、SNAPSHOT_STALE 的 409 语义，绝不回写原生工具。通过并发测试验证提交期间出现新轮、过期样本、缺少轮次和重复请求，失败时不得自动标记后来的轮次。

## 10. 迁移主机配置写入接口
Goal: 在内存中管理采集目标及其启停生命周期。
Description: 通过 `backend-go/internal/api/generated` 实现 OpenAPI 已定义的主机新增、启停和删除 handler，参考 `backend/src/routers/hosts.ts`，通过可替换的候选解析器与调度接口隔离尚未接入的真实 SSH。新增主机初始为 unknown，停用保留 stale 样本，删除仅清理对应存储主机的数据并处理其他会话的工作区引用。测试重复目标、无效输入、本地主机限制和删除边界，并为在途采集结果设置主机代际校验接口，防止删除后旧结果重新写回。

## 11. 导入并解析系统 SSH 配置
Goal: 复用用户已有 SSH 配置而不复制凭据。
Description: 在 `backend-go/internal/collector` 优先评估维护中的 SSH config 解析库，以夹具核验后实现明确 Host 别名与 Include 的有界枚举，并通过系统 `ssh -G` 解析选定别名的有效配置，供主机配置接口使用。保留通配规则和 ProxyJump 语义，不将通配符展开为虚构设备，不执行配置以外的任意用户命令。以配置夹具和假命令执行器验证循环 Include、缺失文件、重复别名、空格路径与解析失败，记录动态 Match 等不能可靠枚举的限制。

## 12. 实现有界的本地和 SSH 命令执行器
Goal: 让慢设备、异常输出和取消不会拖垮后端。
Description: 在 `backend-go/internal/collector` 使用 `os/exec` 和 `context` 实现受控本地探针及系统 OpenSSH 调用，设置连接/执行超时、非交互认证、stdout/stderr 上限和全局并发上限。固定允许的操作和路径传递协议，校验目标及远端 shell 转义，保持主机密钥校验，不接受客户端提交任意命令。通过假子进程测试超时、取消、超大输出、非零退出和 Windows 子进程清理，确认退出后没有持续占用资源的采集进程。

## 13. 接入现有只读探针协议
Goal: 先让 Go 能运行已有真实采集能力而不重写所有解析器。
Description: 阅读 `backend/src/collection/once.ts`、`backend/src/collection/probe.py` 和 `backend/tests/probe_test.py`，将所需探针整理到 `backend-go/probes/`，定义带版本的请求/结果协议及 Go 解码器。使用受控 stdin 传入操作和目标，探测本地/远端既有 Python 与 sqlite3 能力，禁止安装缺失运行时及将真实输出写入临时文件。用脱敏输出夹具验证未知协议版本、部分来源失败、非法字段、输出截断及现有测试语义，缺失运行条件时返回能力不可用而不是假数据。

## 14. 实现 Codex CLI 增量日志读取
Goal: 避免每次轮询重新扫描完整 Codex 历史日志。
Description: 基于 `backend-go/probes/` 和 `_docs/backend/real-snapshot.md` 实现按文件身份、偏移量和完整记录边界读取 JSONL，保持 cli/exec 来源筛选并排除已知 Desktop、IDE 和子代理来源。游标仅在结果成功提交后推进，处理半行、截断、轮转、超大记录和有界发现分页，不沿用“最多 15 个样本”作为完整监控保证。通过合成日志验证续读无漏项、重读可去重、轮转后可恢复，并明确字节预算耗尽时的续扫与部分覆盖标记。

## 15. 补齐 Codex CLI 最新用户指令关联
Goal: 修复当前真实 Codex 样本中最新指令缺失的已知问题。
Description: 以 `backend/src/collection/probe.py` 的现有解析和 `_docs/backend/real-snapshot.md` 的缺口为输入，验证 event_msg 与 response_item 中用户消息和最新 turn 的关联规则。仅在可证明属于当前任务时发布指令，不把系统提示、上下文注入、工具输出或上一轮消息作为最新用户输入。交付脱敏多轮夹具、解析测试和 `_docs/research/go-codex-fields.md`；本会话无法证明的格式保持 null 并记录需要的证据。

## 16. 验证 Codex CLI 生命周期并实现已证实映射
Goal: 为 Codex CLI 发布有证据支持的状态能力。
Description: 参考 `_docs/research/feasibility.md` 与增量日志协议，在一次限时研究中核对开始、完成、中断、等待及恢复事件与 turnId 的关系，记录实际来源版本。只实现已证实的状态映射，历史 task_started 或进程存在不能单独证明当前 Running，中断不转换为成功 Unread，缺失证据保留 Unknown。交付 `_docs/research/go-codex-lifecycle.md` 和事件回放测试，未观察到的等待或原生已读信号明确列为未验证。

## 17. 实现 Cursor IDE 有界一致性读取
Goal: 持续读取 IDE 会话而不复制或全表扫描大型数据库。
Description: 根据 `backend/src/collection/probe.py` 和 `_docs/research/feasibility.md` 中的键访问证据，在探针中实现只读事务、索引定位、有界候选分页和变化检测，保留窗口内会话的后续跟踪。不得修改源数据库设置、禁用锁或把单独复制主库文件视为 WAL 一致性快照；候选更新时间只用于发现，不直接作为 Agent 活动时间。用临时 SQLite/WAL 夹具验证并发写入、数据库忙、缺失键、超大值和分页恢复，确认正常轮询不读取全部正文。

## 18. 验证 Cursor IDE 最终响应与最新轮关联
Goal: 区分 IDE 的最终回答、中间文本和旧轮内容。
Description: 以 `_docs/backend/real-snapshot.md` 和 IDE bubble/composer 脱敏夹具为输入，在一次工作会话内核对最新用户指令、助手消息、终止标记与轮次身份的关联。仅对已验证的结构实现最终响应提取，不把思考、工具内容或最后一条 assistant 消息默认视为最终回答。交付 `_docs/research/go-cursor-ide-fields.md` 及多轮、未完成、缺字段测试；验证失败时保持 response=null 并明确后续取证条件。

## 19. 验证 Cursor IDE 生命周期能力
Goal: 明确 IDE 哪些状态可可靠发布及哪些必须降级。
Description: 使用 `_docs/research/feasibility.md`、IDE 只读读取结果和已授权的代表性证据，限时验证完成时间、执行活动、等待与异常退出信号，原生查看检测仅作为可选研究。不能因 composer.status 名称或 lastUpdatedAt 变化就宣称 Running、完成或已读。交付 `_docs/research/go-cursor-ide-lifecycle.md` 和状态序列测试，每项结论记录来源版本、证据与未支持项。

## 20. 验证 Cursor CLI 最新轮图结构
Goal: 判断 Cursor CLI 能否可靠提供最新指令和最终响应。
Description: 参考 `_docs/research/feasibility.md` 中 `store.db`、`latestRootBlobId` 和 blob 图的证据，进行一次限时的只读结构研究，禁止从 rowid 推断消息顺序。对可以验证的路径实现有界图遍历与最新轮提取，处理环、缺节点、未知编码和不可读取内容，不导出密钥或不透明 blob。交付 `_docs/research/go-cursor-cli-fields.md`、最小脱敏夹具与测试；无法验证时保留发现/目录能力并输出阻塞结论，不无限扩大逆向范围。

## 21. 验证 Cursor CLI 生命周期能力
Goal: 避免把 Cursor CLI 的元数据变化误报为执行状态。
Description: 以 `_docs/research/go-cursor-cli-fields.md` 和该来源的已验证最新轮输出为输入，限时检查开始、完成、等待、中断和活动时间的可观察证据。若最新轮仍不可确定，本任务交付不可验证结论与所需样本，不猜测完成、不套用 IDE 或 Codex 的事件语义。通过支持与不支持两类回放测试验证状态降级，并记录到 `_docs/research/go-cursor-cli-lifecycle.md`。

## 22. 汇总来源能力与可行性门槛
Goal: 将字段支持范围变为可测试的产品边界。
Description: 汇总 `_docs/research/go-*-fields.md`、`go-*-lifecycle.md` 及已有真实采集统计，在 `_docs/backend/go-capabilities.md` 按来源和版本列出 verified、candidate、unavailable。为探针结果增加或校验能力声明，未验证字段只能以候选诊断或 null 发布，不允许新鲜采集提升未知状态的可信度。用契约测试验证降级输出，若核心字段仍不可得则提出明确的缩范围选项供用户确认，但不阻塞已验证来源的基础服务开发。

## 23. 规范会话身份与工作区归属
Goal: 正确区分记录存储设备和实际工作目录设备。
Description: 根据 `backend/src/models/types.ts`、`_docs/research/feasibility.md` 和 Go 探针输出实现稳定来源命名空间、原生会话 ID 及工作区 URI 映射，storageHostId 与 hostId 保持独立。无法解析的远端身份保持 null，同名路径不跨主机合并，重复读取同一原生记录不得生成新卡片。以本地、Remote-SSH、主机别名变化和无法解析 URI 的夹具测试身份稳定性与新鲜度归属。

## 24. 实现 Git 与非 Git 项目归组
Goal: 在可靠证据范围内合并仓库和 worktree。
Description: 使用已规范的会话工作区及受控执行器，读取 Git common dir、分支和可用 origin，设置命令超时与查询缓存，不改变工作树。验证 SSH/HTTPS origin 归一化时去除凭据，缺少可信等价关系时回退到同机 common dir 或主机限定目录，不按仓库显示名合并。通过成对等价/不等价、无 origin、非 Git、目录消失与远端查询失败测试，在 `_docs/backend/go-identity.md` 记录边界。

## 25. 实现最新轮状态归约与首次导入
Goal: 将采集证据稳定转换为五态而不产生虚假未读。
Description: 依据 `_docs/plan.md`、`_docs/backend/go-capabilities.md` 和规范化会话输入，在 Go 中实现只针对最新轮的纯状态归约器，首次成功导入的历史完成为 Read，已跟踪后观察到的新完成为 Unread。固定首次导入截止及追踪边界，处理重复事件、迟到事件、新轮替换、失败中断和不完整导入，不以每次轮询或失败重试重置基线。使用可控时间和事件序列测试所有转换，并明确纯内存重启会重新导入、丢失上次已读基线的限制。

## 26. 实现每主机独立的持续调度器
Goal: 网页关闭后仍能按默认 15 秒间隔进行有界采集。
Description: 使用 `backend-go/internal/collector` 的接口构建调度器，以假采集器先验证每主机单飞、全局并发上限、失败退避、暂停、恢复和公平排队。手动或打开会话产生的高优先级请求合并到同一调度体系，不突破并发上限或让某台慢主机阻塞其他主机，不积压无界定时任务。用标准库定时器及成熟并发原语实现最小调度，避免另建通用任务框架，并通过假时钟验证慢于周期读取、重复触发、取消和退避恢复，记录 15 秒为检查目标而非网络完成保证。

## 27. 实现采集结果提交与新鲜度计算
Goal: 只有真实成功读取才能更新相应样本的新鲜度。
Description: 将 Go 采集协议、状态归约器和内存仓储连接起来，按主机代际、采集版本与来源覆盖范围原子提交结果和游标，拒绝迟到批次覆盖新结果或恢复已删除主机。区分全量发现、定向读取、部分成功和失败：未读取的会话不能因同主机其他来源成功而被洗成 fresh，分页未见的会话也不能直接删除。测试部分来源失败、会话读取失败但主机可达、乱序返回、删除竞争和过期计算，保留最后成功内容而不伪造执行活动时间。

## 28. 实现定向会话刷新接口
Goal: 打开会话能够优先重新读取该会话的真实来源。
Description: 按 `_docs/backend/go-contract.md` 的新增刷新协议实现定向提交和任务状态查询，将会话 ID 在服务端解析为可信来源定位信息，不接受客户端任意路径。接入持续调度器，合并同会话在途请求并限制任务记录数量和存活时间，结果关联明确的采集版本；HTTP 请求取消不应取消其他观察者共享的任务。测试 202 与完成结果的区别、重复打开、停用主机、来源记录消失、超时、过期任务和权限，失败时保留原内容与真实时间戳。

## 29. 接通全局刷新和主机配置生命周期
Goal: 让现有刷新与主机操作真正控制后台采集。
Description: 将 `POST /api/refresh` 和主机增删启停接口接入 Go 调度器，保持 204 仅代表任务接受或合并，不代表所有来源成功。全局刷新只针对已启用主机，暂停/删除取消对应在途操作并阻止旧结果落库，恢复后安排新检查。通过假采集器集成测试全局与定向刷新竞争、重复点击、恢复及删除中途返回，证明不会自动回退到 seed 或快照空操作。

## 30. 用 Orval 生成前端类型与请求服务
Goal: 用一份契约替代手写 TypeScript DTO 和逐接口请求模板。
Description: 依据 `_docs/api/openapi.json` 和 `_docs/backend/go-contract.md` 配置锁定版本的 Orval，在 `frontend/src/services/generated` 生成类型及请求函数，并用自定义 transport 统一 Bearer、超时、AbortSignal、204 空正文、错误转换与 401 清理。以生成请求适配现有 BoardService，`services/types.ts` 只保留必要别名或非 HTTP 抽象，不复制 DTO；本阶段只生成请求而不再生成一套绕过 BoardService 的 Query hooks，以便复用现有 mock。通过现有 HTTP 服务测试和生成重现检查验证 null、枚举、202/204、取消及并发 401，删除被替代的手写请求，组件不直接导入生成请求或调用 fetch。

## 31. 使现有 mock 与生成契约对齐
Goal: 保留无需后端的完整演示，不引入重复的模拟架构。
Description: 以 `frontend/src/services/mock.ts`、生成 DTO 和 `_docs/backend/go-contract.md` 为输入，保留现有 BoardService mock，补充定向刷新进行中/成功/失败、任务过期及轮次变化的可控状态。Mock 与 HTTP 模式通过同一服务入口显式选择，HTTP 失败绝不自动回退 mock，合成时间和业务状态必须可复现而非随机生成。测试无后端运行及已读冲突语义；仅记录 Orval/MSW 后续替换的收益条件，不默认安装 MSW 或维护第二套 handler，自动生成随机响应不能替代状态场景。

## 32. 用 TanStack Query 替换手写请求状态管理
Goal: 减少轮询、缓存和加载状态的重复实现。
Description: 以 `frontend/src/hooks/useBoard.ts` 和统一 BoardService 为输入，在 `frontend/src/services/queries` 建立薄 Query/Mutation hooks，用 TanStack Query 管理稳定 queryKey、缓存、看板轮询和主机修改后的失效；queryFn 必须调用 services，HTTP 与 mock 共用 hooks。显式配置重试、staleTime、聚焦/重连行为和任务轮询终止条件，缓存陈旧不等于来源 stale，登出或 401 时取消查询并清空私密缓存，禁止查询结果持久化到浏览器存储。通过 fake timers 和独立 QueryClient 验证缓存先显示、轮询停止、401 不重试、Mutation 不盲目重复及会话切换隔离，取消信号传到底层 transport，删除已被库接管的 timer/requestId/loading 管理。

## 33. 实现打开详情真实刷新与安全已读
Goal: 缓存立即显示，真实检查完成后更新同一会话。
Description: 基于 `frontend/src/services/queries` 和生成的刷新协议修改 `SessionDetail.tsx`，每次打开显式提交定向刷新 Mutation，再查询任务结果并加载相应采集版本的详情；单纯 Query refetch 只读取 API，不能冒充远端重采。成功检查后仅对实际展示的最新已完成轮次提交 read，服务端单飞配合前端操作身份避免重复打开/重挂载造成风暴，关闭或切换后迟到响应不得覆盖其他会话或自动标记未展示内容。用组件测试覆盖缓存先显、超时保留旧内容、任务终止停止轮询、重试、新轮竞争和卸载，并验证失败仍保留简短可重试提示。

## 34. 按需用 Ant Design 替换基础 UI
Goal: 减少弹窗与表单基础代码，同时保留现有看板布局。
Description: 以 `frontend/src/components/Modal.tsx`、`HostSettings.tsx` 和 `AuthGate.tsx` 为输入，先选择一个边界明确的弹窗/设置流程改用 Ant Design 的 Modal/Drawer/Form 等组件，配置中文文案及统一主题，不同时重写所有卡片和页面。复用组件自带的焦点管理、键盘关闭、表单反馈与加载态，清理对应自制基础逻辑和失效 CSS，继续通过 services 完成业务调用。以组件测试验证键盘操作、表单提交、异步关闭及原有交互，并比较手写代码变化与构建体积，若仅增加包装而无收益则保留原实现并记录取舍。

## 35. 用轻量状态展示替代重复诊断大框
Goal: 减少视觉打扰但保持数据真实性和错误可见性。
Description: 修改 `SessionDetail.tsx`、`ProjectList.tsx` 和 `lib/presentation.ts`，按已选 Ant Design 主题复用 Tag、Spin、Alert、Collapse 等适合的组件，将缓存说明、来源能力和 reason 放入可展开采集详情。常态仅显示检查时间及更新状态，真实失败显示一条重试提示，网络连接、采集新鲜度和任务结果保持区分，不把 stale 当离线或把历史已完成抹成未知。测试更新中、旧缓存、Unknown、部分失败和认证失败的文案与可访问性，删除重复提示分支和无用样式，不为统一视觉再造一层通用组件库。

## 36. 增加不含会话正文的运行诊断
Goal: 能定位采集瓶颈而不把私人会话写入日志。
Description: 使用 Go 标准库 `log/slog` 为调度与采集记录结构化的耗时、读取字节、来源计数、队列等待、失败类别和最后成功时间，区分服务健康与单台设备失败。日志不得包含 prompt、response、密码、Bearer、SSH 密钥、原始 stdout/stderr 或带凭据的路径，错误字符串经过边界清理。使用含敏感哨兵值的合成测试验证不泄漏，并在 `backend-go/README.md` 记录诊断开关与最小保留策略，不新增外部遥测平台。

## 37. 完成服务启动和优雅停止
Goal: 将 API、调度和采集进程组成一个可控的 Go 服务。
Description: 在 `backend-go/cmd/board` 以标准 `http.Server` 托管 Gin 生成路由并集成认证、内存仓储、执行器与持续调度，显式区分 demo、单次快照和持续真实模式，真实模式不得默认填充合成数据。接到停止信号后拒绝新任务、取消后台采集、限时结束 HTTP 并等待子进程回收；处理端口占用、无效配置和重复启动，确保失败启动不留下孤儿调度器。用启动/停止集成测试验证没有网页请求时仍采集、关闭网页不影响后台以及停止后不再采集，不替换当前预览服务。

## 38. 打包前端与采集运行资源
Goal: 让发布版不依赖开发用 Vite 进程和源码目录。
Description: 为 Go 服务增加同源前端静态资源交付及可定位的探针资源打包流程，保留开发代理模式，明确 Python/OpenSSH 是需要检查的外部运行条件而非声称完全单文件无依赖。限制静态路径穿越，保证 `/api` 错误不被 SPA 回退吞掉，并将 OpenAPI 与构建产物一起版本化。测试干净发布目录中的健康检查、登录、静态页面、资源缺失和探针定位，在 `backend-go/README.md` 记录构建与运行步骤。

## 39. 提供 Windows 后台运行与恢复方案
Goal: 当前 Windows 主机能在不打开网页时保持服务运行。
Description: 以 Go 发布产物为输入，选择并记录一个用户级后台托管方案，例如 Windows 任务计划程序，定义工作目录、环境、单实例、登录自启和失败重启策略，不默认要求管理员服务。提供用户显式执行的安装、状态检查和卸载步骤，后台窗口隐藏，不在本任务中擅自注册自启或终止当前运行实例。验证脚本参数与手动托管流程，并明确注销、休眠、关机及纯内存重启的数据限制，不能宣称宿主机关机仍采集。

## 40. 建立契约与生成产物回归检查
Goal: 防止生成器或依赖升级导致两端协议漂移。
Description: 基于 `_docs/api/openapi.json` 及已锁定的 oapi-codegen、校验中间件、Orval 配置，建立文档校验、重复生成无差异和 Go/TypeScript 编译检查，生成文件禁止手工修补。以合成状态检查 Go HTTP 与旧后端可比行为及公开/认证路径，测试 null、错误、日期和额外字段，持续模式新增行为按 `_docs/backend/go-contract.md` 单独验收。交付可复现命令或仓库已有 CI 的最小增量，汇总手写、生成、测试与配置代码量变化，不把生成行数增加视为失败，也不把依赖覆盖当作取消业务测试的理由。

## 41. 增加前后端端到端回归
Goal: 验证成熟组件组合后的真实交互而非只验证生成文件。
Description: 使用现有前端构建和 Go 假采集器服务增加 Playwright 场景，覆盖登录、项目浏览、打开即刷新、已读冲突、主机暂停、注销及纯 mock 独立运行，不连接真实 SSH。检查 TanStack Query 缓存与认证清理、Orval transport 错误适配和 Ant Design 键盘交互，正常流程不得依赖当前开发实例或真实正文。验收为 Go 单测/竞态检测、前端测试/构建与关键浏览器流程通过，记录不可运行的环境条件，不把 mock 成功当作真实来源能力验证。

## 42. 验证调度故障隔离与资源上限
Goal: 确认后台长时间运行不会因异常设备失控。
Description: 使用可控的假采集进程和合成大型数据，测试某主机持续超时、断连、超大输出、不断追加日志、数据库忙和频繁打开详情，记录并发、队列、内存及进程数量。验证正常主机仍前进、任务记录可回收、失败按策略退避、旧批次不覆盖新状态，并检查重试恢复不漏完整记录。交付 `_docs/backend/go-load-validation.md`，写明测试时长、数据规模和实际结果，不将模拟吞吐量当作三机真实 SLA。

## 43. 执行三机只读持续采集验收
Goal: 用实际运行证据判断哪些字段和交互已经可用。
Description: 按 `_docs/backend/go-capabilities.md` 在独立端口对本机、`t-11257`、`nb-11257` 进行至少 30 分钟有界只读验证，记录软件版本、覆盖范围、字段命中率、延迟和失败，不保存真实正文或原始数据库。关闭看板一段时间后再打开，证明后台采集继续且打开会话触发新的定向检查，同时用日志统计而非仅 UI 时间戳证明真实读取发生。交付 `_docs/backend/go-real-validation.md`；自然样本没有覆盖的等待、完成或原生已读场景仍列未验证，不额外启动 Agent 制造证据。

## 44. 整理交付文档与可回退切换方案
Goal: 让 Go 版本的支持范围、部署方式和迁移风险可审查。
Description: 汇总 `_docs/backend/go-contract.md`、`go-capabilities.md`、`go-real-validation.md` 和发布说明，更新 API 文档及数据缺口，明确哪些旧文档描述演示或单次快照，哪些描述持续监控。提供独立端口试运行、前端代理切换、回退旧后端、弱密码调整及内存丢失说明，不删除旧实现、不擅自停止当前快照实例。以发布检查清单验收文档与接口一致，实际切换需用户确认，不能将本任务的文档完成视为真实采集能力全部通过。

## 45. 确认持久化范围与隐私策略
Goal: 在任何 SQLite 实现前明确用户允许落盘的数据。
Description: 基于此前“数据存在内存中”的要求和 `_docs/plan.md` 的重启保持诉求，提交纯内存、仅配置/已读/游标持久化、额外保存最后正文三种明确选项，解释重启、首次导入及已读连续性的差异。特别说明仅保存游标但丢失会话聚合状态可能无法重建详情，须选择重新回放或保存获准的最小重建状态，不能盲目从旧偏移续读。将用户决定或“尚未确认，继续内存”记录到 `_docs/backend/go-storage-decision.md`；本任务不创建数据库，后续条件任务必须等待明确授权。

## 46. 条件任务：实现获准的 SQLite 仓储
Goal: 仅将用户批准的数据类别持久化到本机应用数据库。
Description: 仅在 `_docs/backend/go-storage-decision.md` 明确批准后，为 `backend-go/internal/store` 增加 SQLite 实现，选择并记录符合目标构建方式的驱动、schema 版本和最小迁移机制，数据库与 Agent 原生数据库严格分离。只保存批准字段，事务覆盖需要一致提交的最新轮标识、阅读状态、基线和游标，真实正文未获准则禁止进入表、日志、备份或测试产物。使用临时数据库验证仓储契约、并发事务、迁移失败与磁盘错误，纯内存模式保持可独立运行。

## 47. 条件任务：验证重启恢复与首次导入连续性
Goal: 证明持久化版本重启后不会漏采或错误重置未读状态。
Description: 在获准的 SQLite 仓储和 `_docs/backend/go-storage-decision.md` 恢复策略基础上，接入服务启动恢复，校验来源文件身份和游标，不匹配时安全重建而不是跳过数据。通过中断提交、来源轮转、无正文持久化、启动期间新轮到达、数据库损坏和重复重启测试验证不漏已完成记录、不误标已读，令牌仍按既定策略重启失效。更新 `backend-go/README.md` 的恢复与清理步骤；若用户选择纯内存，本项与前一项 SQLite 实现任务标记不适用，不阻塞核心 Go 版本交付。

# 只读采集可行性验证

- 调查日期：2026-10-22，Asia/Shanghai；本次为静态快照与有限查询测量。
- 范围：本机 Windows、现有 SSH 别名 `t-11257`、`nb-11257`。用户后续授权远端检查，取代此前“仅本机”的限制。
- 状态：**部分可行；完整 MVP 数据源门槛未通过。** 本文不代表后端已实现。
- 基线：[冻结需求](../plan.md)、[证据清单](evidence.json)、[接口草案](../api/openapi.json)。
- 本次不修改前端、不启动新的 Agent 任务、不修改原生会话；远端未安装工具、未写入采集器。

## 1. 结论

| 能力 | 本次结论 | 证据 |
|---|---|---|
| 现有 SSH 连接两台设备并读取元数据 | 已实测；复用现有配置与已知主机，不关闭主机校验 | E05、E06 |
| Codex 真正 CLI 历史的任务开始、完成、中断与耗时字段 | T-11257 样本支持；仅历史事件，不等于实时状态已通过 | E05 |
| Cursor IDE 会话发现与精确键查询 | 本机及 NB-11257 可读；正文/最终回复语义仍需行为验证 | E03、E07 |
| 本机 IDE 会话关联远端工作区 | 已找到两台设备的映射；不能把存储位置当执行位置 | E04 |
| 同机 Git worktree 合并 | NB-11257 的三个 worktree 指向同一 common dir | E06 |
| Cursor CLI 会话发现 | T-11257 找到两份存储；最新任务顺序与最终回复解析未打通 | E08 |
| 等待审批、恢复、原生已读 | 存在候选字段/官方协议，未验证现有会话被动采集 | E02、E03、E09 |
| 15 秒轮询、故障隔离与持续实时准确性 | 有查询性能依据，但尚未完成端到端持续验证 | E03、E07 |

可以进入**限定版本、限定能力的采集 PoC**，不能宣称“三种来源完整支持”。若不允许降低冻结需求，应先补齐第 7 节门槛，再实现正式后端。特别是 Cursor CLI 最新任务解析，当前仍是核心阻塞项。

## 2. 方法与隐私边界

SSH 使用 `BatchMode=yes`、`StrictHostKeyChecking=yes`、`ConnectTimeout=8`，通过 stdin 执行远端已有 Python 3。两台机器都已有 Python 的 sqlite3 模块；没有 sqlite3 命令行程序不代表无法读取数据库。非交互 SSH 的 PATH 找不到 cursor-agent，但绝对路径可用，不能据此判定未安装。

SQLite 使用 URI `mode=ro`、`PRAGMA query_only=ON`、显式只读事务，结束后 rollback/close。未 checkpoint、修改 journal mode、复制正在写入的主库或使用 immutable 绕过锁；只读 WAL 访问仍依赖 sidecar 权限与正常协调，不能保证完全没有共享内存锁交互。本机初次沙箱读取失败，取得授权后成功，不应归因于格式不支持。[SQLite URI](https://www.sqlite.org/uri.html)、[WAL](https://www.sqlite.org/wal.html)。

只保留数量、大小、字段名、枚举、耗时与少量事件时间。报告不包含真实提示词、回复、仓库 URL、远端用户目录、完整会话 ID、IP 或凭据。Cursor CLI 元数据中出现疑似密钥字段，仅记录字段名，不保存值。证据清单是工具输出的脱敏摘要，不是可重放的原始数据库快照。

## 3. 环境与来源识别

| 设备 | Codex 已安装版本 | Cursor CLI 已安装版本 | 已验证的存储 |
|---|---|---|---|
| 本机 Windows | 0.163.0-alpha.11 | 检查路径未找到可执行文件，不证明完全不存在 | Codex Desktop 日志/SQLite；Cursor IDE 3.22.7 数据库 |
| t-11257 Linux | 0.163.0 | 2026.10.16-e3cb207 | Codex 各来源日志；Cursor CLI 两个 store.db |
| nb-11257 Linux | 0.158.0 | 2026.05.04-08e5280 | Codex vscode 来源日志；完整 Cursor IDE 数据库 |

**安装版本不等于样本生产版本。** T-11257 真正 CLI 样本由 0.154.0 生成。NB-11257 日志同时有 source=vscode 与 originator=codex-tui，不能只看 originator 就归类为 CLI。本机本轮两个 JSONL 均属于 Desktop/其子任务，不能冒充本机 CLI 的验证。

### 3.1 Codex

- T-11257：666 个 rollout 文件头，source 分布为 38 cli、5 exec、82 vscode、541 结构化子代理来源。
- 真正交互 CLI 样本约 17.3 MB：15 次 task_started、14 次 task_complete、1 次 turn_aborted；完成事件携带 last_agent_message 与 duration_ms。
- 该样本最新开始发生在最后一次成功完成之后，随后明确中断。**不能拿前一轮完成事件给最新轮标记 Unread。**
- exec 样本也有任务开始/完成事件，但须作为 CLI 的另一变体单独适配。子代理、Desktop 不能默认混入冻结的 CLI 范围。
- 本机 state_5.sqlite 中有 threads 与 thread_read_receipts；存在读取标记字段不等于已经证明原生点击与状态转换关系。只枚举 JSONL 也不应被视为完整会话发现。
- 发现 task_started、task_complete、turn_aborted、item_completed 等内部事件。item_completed 只说明一个 item 结束，不代表整个任务成功。
- 旧任务有开始无终止、进程存在/消失、日志停止增长，均不足以单独判定当前 Running 或成功完成。

### 3.2 Cursor IDE

本机 state.vscdb 快照约 1.04 GB，287 个 composerHeaders；NB-11257 约 6.69 GB，2830 个 composerHeaders，3109 个 composerData 键。两个计数不相等的原因未验证，不能假设所有旧记录都有 header。

可用结构为 composerHeaders → composerData:<id> → fullConversationHeadersOnly → bubbleId:<composerId>:<bubbleId>。使用索引/精确键，避免在 GB 级库中全表 LIKE 或把整个数据库传回本机。

本机最近五个样本包含 completed、aborted、none；其中草稿没有消息，不能生成 Running 卡片。type=1/2 与用户/助手消息的对应是样本推断，不是稳定的官方协议。助手 bubble 可能是思考或工具过程，最后一个助手 bubble 不必然是最终答案。

存在 hasBlockingPendingActions、hasUnreadMessages、lastReadAtMs、turnDurationMs 等候选字段；未验证实时转换。最终回复候选缺少明确 completedAtMs，不能用 composer.lastUpdatedAt 代替任务完成时间，也不能据此执行精确 24 小时隐藏。

工作区关联：287 个 header 中，188 个可关联本地 file 工作区，22 个关联 vscode-remote，77 个未匹配本机 workspace.json。远端映射中 nb-11257 有 12 个、t-11257 有 2 个。SSH authority 可能编码别名或十六进制 JSON，不能简单按路径前缀匹配。

### 3.3 Cursor CLI

T-11257 的 ~/.cursor/chats/<scope>/<session>/store.db 两个样本均有 blobs、meta 表；配套 meta.json 含 cwd、schemaVersion、创建/更新时间字段。

meta 的一个值为十六进制编码 JSON，解码后有 agentId、latestRootBlobId、mode、blobEncryptionKey 等字段。blob 混合 JSON 消息与不透明二进制；两份数据库分别为 179 / 11 个 blob，其中 114 / 7 个不是已解析 JSON 消息。

**未完成 root graph 的遍历和顺序证明。** 不能按 SQLite rowid、任意遍历顺序或“最后一个 assistant”构造最新任务与最终回复。看到 blobEncryptionKey 字段也不能断言所有内容均加密，因为实测部分消息可直接解码。NB-11257 未找到同一路径的 chats，不代表其他版本没有不同位置的历史。

## 4. 时间与性能证据

| 探测 | 实测 | 限制 |
|---|---|---|
| 本机 IDE 20 个会话及末尾 bubble 精确键查询，5 次 | 20.02 / 6.33 / 4.28 / 3.53 / 3.33 ms | 局部元数据查询，不是全库正文解析 |
| NB-11257 IDE 最近 20 个 header 与 composer 值长度，3 次 | 192.07 / 39.45 / 37.07 ms | 远端内部耗时；长度合计 979297，不代表实际传输正文 |
| 上述 NB 查询的一次 SSH 工具命令 | 3.69 s | 包含 SSH/进程开销；单次不是 p95 |
| T-11257 666 文件头及代表性日志采样 | 远端约 1.639 s | 广泛首轮诊断；不是推荐的每 15 秒扫描 |
| NB 日志/元数据采样 | 远端约 0.138–0.308 s | 与 IDE 查询不同操作，不能合并算吞吐 |

判断：**索引查询与增量采集值得继续验证**，并非“15 秒 SLA 已证明”。正式 PoC 应保存文件偏移与大小/替换标记，SQLite 按可靠变更索引增量读取，每主机单飞，读取/传输有界，独立超时。不能每轮全量读 6.69 GB 数据库或 666 个完整历史文件。

## 5. 能力矩阵

“候选”表示字段/静态样本存在但行为未证实；“未验证”不等于不可能。

| 来源/样本 | 发现 | 最新轮身份 | 开始/成功终止 | 最终回复 | Waiting | 原生 Read | 工作区 |
|---|---|---|---|---|---|---|---|
| Codex CLI，T，日志 0.154.0 | 实测 | turn_id 字段实测，归并待测试 | 历史事件实测 | last_agent_message 字段实测 | 未验证 | 未验证 | cwd 实测，样本非 Git |
| Codex CLI，本机/NB | 真正 CLI 样本不足 | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 |
| Cursor CLI，T | 实测 | 阻塞：图与顺序未解 | 未验证 | 未验证 | 未验证 | 未验证 | cwd 字段实测 |
| Cursor CLI，NB | 可执行文件实测，历史未定位 | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 |
| Cursor IDE，本机 | 实测 | 用户 bubble 候选 | status 候选 | 候选，不能等同 final | 候选 | 候选 | 部分实测，77 未匹配 |
| Cursor IDE，NB | 表/索引实测 | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 |

## 6. 对接口设计的直接影响

1. storageHostId 与 hostId 分开：前者是采集存储设备，后者是执行工作区设备，未知允许 null。离线判断不能只看执行位置。
2. turnId、directory、prompt、activityAt 等可能无法证明，不能为了满足当前前端的必填 string 而伪造空字符串或时间。
3. 状态与 freshness 独立；保留最后状态时必须显示 stale 与原因，旧 Running 不能计入“已确认正在运行”。
4. markRead 必须携带最新 turnId 并原子校验；读旧卡片不能把新任务标为已读。只写应用自己的标记，不回写原生数据库。
5. durationSeconds 只能来自已确认的任务计时；未知 null。中断不是成功，不产生 Unread。
6. 原生读取能力未知时使用 Web-only read；首次完成历史导入 Read，后续已监控任务完成 Unread。
7. 不把 lastUpdatedAt、文件 mtime、Web 点击时间当 Agent activity。缺少可靠时间无法严格执行 7 天规则，接口草案建议显示 unknown/warning，不静默隐藏；这是待确认的降级策略。
8. 仓库身份仅在可证明的情况下归并。同机三个 worktree 合并实测通过；跨主机 SSH/HTTPS origin 等价归并尚未验证。

## 7. 尚未通过的验收与下一步

以下是独立、可单次执行的验证任务；需要改变原生会话的场景应另行取得用户许可，本轮未执行。

| 编号 | 验证任务 | 通过标准 |
|---|---|---|
| V1 | T 上选一份 Cursor CLI store.db，解析 latestRootBlobId 图及消息顺序 | 对照原生界面证明至少两轮顺序、最新提示词与最终回复；无法解析则明确此版本不支持 |
| V2 | Codex 真正 CLI 的实时一轮 | 开始→持续执行→成功完成与 turn_id 对齐；测到采集延迟，不能靠进程存活 |
| V3 | 每种来源的审批/输入等待与恢复 | 有稳定原生证据，并区别工具运行、用户取消、超时；否则能力标记 unavailable |
| V4 | 原生查看与 Web 阅读竞争 | native read 确认作用于最新轮；旧 turnId 返回 409；新轮不会被误读 |
| V5 | 中断、崩溃、损坏尾行、文件轮换 | 不误报完成，保留 Unknown 原因；后续增量扫描可恢复 |
| V6 | 三机持续轮询与断网恢复 | 建议至少 30 分钟，每主机不重叠；记录 p50/p95、流量与CPU，坏主机不阻塞好主机 |
| V7 | 同仓库跨主机与 SSH/HTTPS origin | 正确合并，凭据不入 ID；同名不同仓库及无 remote 不误合并 |
| V8 | 首次导入、服务重启、7 天/24 小时边界 | 完成历史默认 Read；新完成 Unread；状态持久化；未知完成时间不伪造隐藏依据 |

优先 V1，再 V2/V3。若 V1 失败，需用户决定暂缓 Cursor CLI 或改变“零工作流改动”约束，不能自行用 wrapper 替代需求。

## 8. 官方资料与适用边界

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：提供 thread/turn 与审批交互协议，可作为语义参考；没有证据表明新起一个 server 就能被动订阅所有现存 CLI 的审批。未使用它声称被动采集已经可行。
- [Cursor CLI](https://cursor.com/docs/cli/overview)、[Headless](https://cursor.com/docs/cli/headless)：CLI/非交互使用方式不等于现有会话历史的稳定公开读取 API；本项目不要求重启任务为 wrapper 输出。
- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)：用于描述提议的本地 HTTP 契约，不描述 Cursor/Codex 内部数据库为公开 API。

内部字段均按当前样本记录，升级后必须重新验收。官方协议、实机观察、适配器推断、拟议设计是四种不同证据层级，不可混用。


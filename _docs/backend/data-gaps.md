# 后端数据需求缺口与方案

更新：2026-10-24。本文区分“演示后端已实现”“真实采集缺证据”“本轮主动不做”。实机依据仍是 2026-10-22 的 [可行性报告](../research/feasibility.md)，没有重新连接设备，也没有因提供 seed 而提高来源能力评级。

## 1. 本轮交付边界

已实现：8 个业务接口、登录/注销、内存配置与已读、合成五态/三来源/三主机数据、时间过滤、单轮冲突保护、异步合并刷新。新增 OpenAPI 认证定义，前端可登录且处理 null、unknown 和 warning。

未实现：真实 Agent 采集器、SSH 连接、SSH 配置解析、持久化、原生 read 检测、真实实时状态归约。**演示值不是“假装采到真实值”**：标题、依据、全局 warning 与登录后提示明确标识合成数据。新增主机不会被标成 online。

## 2. 需求与缺口

| 前端需求/字段 | 当前可提供 | 真实来源缺口 | 方案及验收 |
|---|---|---|---|
| 最新任务 turnId、prompt、response | 合成完整样本及 null 样本；read 校验 turnId | Cursor CLI 的 blob 图顺序未解；IDE 最后 assistant 不必然 final | 优先 T-11257 验证 latestRootBlobId 图；对照原生两轮会话。成功再启用能力，否则 null + Unknown，不用 rowid 猜顺序 |
| Running / Waiting | 合成场景与 fresh/stale 展示 | 历史 task_started 不能证明现在仍运行；审批字段缺行为验证 | 每来源录制允许的开始/审批/恢复/终止场景；以 turn ID 归约，进程退出不当完成；无法证明降级 Unknown |
| 成功终止、completedAt、durationSeconds | 合成精确值或 null；中断不造 Unread | IDE 缺可靠完成时间；lastUpdatedAt 可能是查看操作 | 校准 duration 原生语义和终止事件；不能确认则 null，暂停该条精确 24h 隐藏，不填 now/mtime |
| activityAt 与 7 天窗口 | 已知时间按窗口处理；未知保留并警告 | 部分存储 recency 混入界面行为 | 仅消费执行事件时间；待产品确认未知时间单独区/保守显示策略，不能静默丢数据 |
| 工作区 hostId / directory | 允许 null，另有 storageHostId | 本机 IDE 对远端工作区只部分关联，曾有 77 条未匹配 | 解码 workspace URI，主机别名规范化，缺证据不猜；使用存储主机决定 freshness |
| 项目 repository / identityKind | 合成 Git 和非 Git 项目 | 只证明同机 worktree common dir，未证明跨机 origin 归一化 | 用成对 SSH/HTTPS remote 夹具验证相等/不等；去凭据；歧义回退主机限定目录 |
| 原生已读 nativeRead | Web-only，当前种子能力 unavailable | read receipt/IDE 字段存在但无点击行为证明 | 先验证原生打开最新轮前后变化；未通过继续 Web-only，不回写原生记录 |
| 主机地址、候选与连接状态 | 合成候选、内存配置；新增为 unknown | 不读取真实 ~/.ssh/config，不执行 SSH | 后续封装只读 Include/Host 枚举及 ssh -G；已有可信主机校验，不自动接受新主机 |
| 每 15 秒自动/手动刷新 | 15 秒演示 timer；请求合并且 204 仅入队 | 无真实采集、网络超时隔离、持续性能验证 | 独立每主机 worker、单飞/超时/有界 IO/增量游标，按 V6 进行三机持续验证；不要每轮复制 GB 数据库 |
| 服务重启保持配置与阅读标记 | 不支持，内存重启清空 | 与原冻结持久化要求不符，但符合本轮指定内存存储 | 下一阶段用 SQLite 仓储替换 MemoryStore；事务保存最新轮+读取标记；迁移/重启测试，不改 HTTP 契约 |
| 真实首次导入边界 | seed 的 Read 表示历史，Unread 表示已跟踪后完成 | 没有真实采集游标及首次成功导入记录 | 持久化 first-success 与任务事件，不用每次重启时间重置历史；V8 验证导入竞争 |
| 多用户/权限隔离 | 单用户部署，认证后共享整个看板 | 没有角色、数据所有权、用户管理或 TLS | 不对外开放；未来多用户需 owners/roles、独立数据与认证系统，不靠 Bearer 字符串充当授权模型 |

## 3. 已解决的前端契约差异

- 登录入口及 Bearer 头都通过 services；401 清除当前令牌，退出与到期清空页面内存，不在浏览器持久化令牌。
- turnId、hostId、directory、prompt、activityAt、repository 可为空；详情不会对未知轮次/过期样本发 read。
- Host.connection=unknown 显示“待验证”，不误称离线或在线。
- Dashboard.warnings 显示合成数据和部分能力提示，详情分别识别存储与执行主机。
- HTTP 模式与原 mock 模式独立，不在失败时回落 seed 掩盖连接错误。

仍保留的取舍：前端类型中 evidence/capabilities/identityKind 尚未提供逐字段能力 UI（后端响应已有，契约测试覆盖）。当前通过全局 warning、reason 和 null 占位表达限制；下一阶段可增加能力详情面板，不应先假定所有 source 完整支持。原 mock 的启停与错误码保持原模拟行为，**不能替代 HTTP 后端契约测试**。

## 4. 建议推进顺序

1. **先解 Cursor CLI 最新轮**：最有可能阻塞冻结需求，失败时由用户决定缩范围或暂停此来源，不能暗中增加 wrapper。
2. **单来源只读采集 PoC**：优先已有明确 task_complete 的 Codex CLI，保留 source/版本隔离；回放多轮、中断、截断样本。
3. **等待与原生 read 验证**：按工具版本声明 capabilities；不可得保持 Unknown/Web-only。
4. **工作区与项目身份**：先同机 worktree，再远端 workspace URI，最后跨主机仓库等价关系。
5. **持久化与真实调度**：在已验证适配器之后接 SQLite、增量游标、主机隔离和重启边界；用压力与故障注入验收。

以上不要求改变既有 Agent 工作流，也不要求在远端安装守护进程。若源格式根本不提供某字段，应在文档与界面明确不支持，而不是由语言模型推断执行状态。

## 5. 安全与运行限制

本地 HTTP + 单用户适合开发演示，不是公网服务。账号密码由环境注入，scrypt 带随机 salt；令牌有过期与撤销且服务器只存摘要。没有忘记密码、自助注册、跨设备会话管理、生产审计日志和持久化撤销列表。关闭/刷新浏览器时令牌仍可能在服务端有效到期，显式注销会撤销当前令牌；断网注销不能证明服务端撤销。

OpenAPI 已从无认证草案更新为 0.3.0；旧匿名客户端必须接入登录。服务端按 schema 验证输入，业务接口均需要 Bearer。来源证据日期与实现日期不能混为一谈。

# 真实单次采集预览

日期：2026-10-24；本轮采集完成时间：10:30:19（Asia/Shanghai）。

**已经执行真实采集，不是 seed。** 读取本机、t-11257、nb-11257；不启动 Agent、不修改原生记录、不安装远端软件。SQLite mode=ro + query_only + 事务，SSH 复用已有可信主机配置。会话内容经管道直接进入后端内存，未保存原始日志、数据库副本、提示词、回复或导出 JSON。本文件仅记录汇总统计。

## 实测结果

| 存储设备 | 成功载入 | 来源 | 最新指令 | 最终回复 | 工作目录 |
|---|---:|---|---:|---:|---:|
| 本机 | 12 | Cursor IDE 12 | 12 | 0 | 10 |
| t-11257 | 17 | Codex CLI 15、Cursor CLI 2 | 0 | 6 | 17 |
| nb-11257 | 12 | Cursor IDE 12 | 12 | 0 | 12 |
| 合计 | 41 | 3 类来源 | 24 | 6 | 39 |

聚合为 16 个项目分组；39 条可提供原生/派生轮次标识，7 条有完成时间及耗时，7 条有 Git 分支。7 条 Codex 历史完成事件导入 Read，34 条保持 Unknown；没有把单次 task_started 推断为当前 Running，也没有假称 Waiting 可用。

实际发现范围：本机 7 个 Codex 文件全不属于已纳入的 cli/exec；T 共检查 723 个文件头，其中 43 个 cli/exec，按文件修改顺序选择最多 15 个可解析样本；NB 本轮 2 个文件均不属于 cli/exec。Cursor IDE header 计数本机 287、NB 2833，各取最近 15 个 header，跳过空会话后各载入 12 条。Cursor CLI 找到 T 上 2 个 store.db。所有主机查询均成功，本轮记录的查询错误和契约拒收均为 0。

这不是完整历史枚举保证：文件头检查上限 2000、每来源最多 15 个、单日志上限 32 MiB、单 SQLite 值上限 2 MiB、每主机输出上限 8 MiB、90 秒超时。按文件修改顺序只用于选择样本，不用于推断任务活动时间。

## 能实现的部分

- 真实会话发现、按存储主机隔离身份、部分工作区/执行主机关联。
- 部分工作目录、Git common dir/worktree/分支；同机 common dir 分组，不做未经验证的跨主机 origin 合并。
- Codex 匹配最新 turn_id 的明确完成/中断事件：历史完成为 Read，中断为 Unknown，旧轮最终回复不污染新轮。
- Cursor IDE 最新用户 bubble 候选、真实标题及工作区；保守不发布助手中间内容为 final。
- 真实服务端 Bearer 认证、内存浏览、字段缺失占位、采集时刻和过期标记。

## 仍然无法确认的部分

- 本轮 Codex CLI 指令为 0：保守解析器仅接收 event_msg.user_message.message，所选样本未取得该字段；尚未验证 response_item 的用户指令与最新轮可靠关联，不能拿上下文/旧轮用户消息填充。
- Cursor IDE 原生 status 与完成/运行语义未行为验证，最终回复及完成时刻均 null；不因 composer.status=completed 就宣称支持。
- Cursor CLI latestRootBlobId 图与顺序未解析；只有会话发现和目录，最新指令、最终回复、轮次/状态缺失。
- Waiting、原生已读、持续运行判定与跨机仓库归并仍未通过验证。
- 简单敏感字符串脱敏不是完整 DLP；页面包含真实本地会话内容，不应截图外传或开放公网。

## 预览模式语义

BOARD_DATA_MODE=snapshot 会启动时采一次，然后保持在内存。没有重采集定时器；网页的自动刷新和手动刷新只重新读取这份内存，不访问来源、不修改采集时间。45 秒后记录显示 stale 是预期行为，不能为方便展示伪造“最新采集”。

为查看能力，本模式明确暂不应用项目 7 天及 Read 24 小时隐藏，所有返回样本都可见；默认演示模式原规则不变。主机启停/添加/删除在该模式返回 400，避免界面配置与固定采集范围不一致。Web 已读仍受轮次和 fresh 校验。重启或停止进程会清空数据和令牌；重新以 snapshot 模式启动会重新采集。

## 启动

在 backend 中配置 BOARD_DATA_MODE=snapshot、BOARD_PYTHON 为本机 Python 3 路径，然后构建并启动。默认账号/密码为 admin/admin，仅限本机预览；可用 BOARD_USERNAME、BOARD_PASSWORD 覆盖，自定义非 admin 密码仍需 >=12 位。需要远端已有 python3 + sqlite3 模块；没有时该主机失败，不安装替代组件。编译产物运行还需保留 src/collection/probe.py 和 _docs/api/openapi.json。

本次临时后端端口 3002，前端端口 5183；前端使用 VITE_SERVICE_MODE=http、VITE_API_BASE_URL=/api、VITE_DEV_API_TARGET=http://127.0.0.1:3002。对应后端 BOARD_FRONTEND_PORT=5183。仅监听 loopback，不影响既有 5173 服务。临时密码只在本次会话交付，不写入文件。

## 验证

新增 Python 合成夹具 4 项通过（轮次隔离、完成历史、IDE 用户 bubble 与只读库不变、常见秘密脱敏）；后端 48 项通过，类型检查/构建通过。实际通过 Vite 代理登录，API 返回 real-snapshot、16 项目/41 会话；检查仅输出字段覆盖率，不输出实际正文。此前的演示模式说明仍适用于默认模式，不能用于说明本次快照的数据来源。


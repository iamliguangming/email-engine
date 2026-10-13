# 独立邮件服务验收记录

测试日期：2026-10-12；记录更新：2026-10-13。范围：独立 Kadri fork；没有修改/部署聘钉生产服务。完整交接见 [测试交接文档](mail-service-test-handoff.md)。更新当天未重新执行测试。

## 自动化

- Node 22.22.1，PostgreSQL 17，pg-boss 12.37.1。
- `MAIL_TEST_DATABASE_URL=隔离测试实例 npm test`：39 项通过，0 失败、0 跳过。
- 其中包含原有 18 项回归、新增规则/provider/HTTP 网关测试，以及 PostgreSQL + pg-boss + 实际 MCP 客户端集成。
- 数据库是真实 PostgreSQL；邮箱协议边界使用合成数据（Gmail/Graph 受控 fetch、IMAP 受控客户端）；完整流程使用模拟 provider 与模拟 AI/入库网关。
- 覆盖连接重启恢复、事务回滚、时间区间/分页、匹配与拉取解耦、人工确认限制、回包丢失幂等回执、失败续拉、取消、持续发现去重、撤权、OAuth 状态与邮箱校验、过期队列任务终态、MCP 工具发现/成功/错误路径。
- AI 重试未重复扣点、项目交付未重复入库的断言针对满足契约的模拟网关；不是聘钉真实积分账本或候选人库联调结果。
- 受检源码与实际仓库所有 src/**/*.ts 按 SHA-256 比对一致。

原始 TAP 输出见 `mail-intake-tests.tap`。

## 容器与 HTTP

- 从实际仓库构建 `Dockerfile.mail`，`compose.mail.yml` 启动 api、worker、postgres。
- API 与 PostgreSQL healthcheck 通过，worker 输出 ready。
- `http://127.0.0.1:8095/health` 返回 ok。
- `/openapi.json` 返回 OpenAPI 3.1，25 个路径。
- 真实容器 HTTP 验证：创建模拟 principal、签发 agent 委托、邮箱列表读取成功、admin token 不能直接读取业务邮箱、只读项目不能绑定、撤销 token 后访问返回 401。
- 首轮容器验收使用的模拟 principal 已停用、token 已撤销；随后已完成下述真实 QQ 邮箱验收。专用测试 PG 容器已清理，服务 Compose 的 PostgreSQL 保留。

## 真实 QQ 邮箱验收

- QQ IMAP 连接成功，最近 7 天 INBOX 拉取 13 封；任务约 5 秒完成。
- 3 封正文抽查成功，分页无遗漏或重复；同幂等键复用原任务。抽查邮件无附件，未验证真实附件下载。
- 经用户授权，从 Gmail 发送唯一标记邮件，独立服务通过后台自然调度自动发现。QQ 收件至事件持久化约 42 秒。
- `mail.discovered` 与 `import.completed` 事件生成成功，下一轮重扫未重复生成该邮件的发现事件，游标补读通过。
- 这不是 webhook 投递验收：新服务尚未实现通用 webhook，当前仅有持久化事件及 `/v1/events`。
- 测试后恢复 `continuous=false`，保留邮箱与数据，未触发 AI 扣点或人才入库。
- 证据见 [历史拉取](testing/2026-10-12/qq-pull-result.json) 和 [事件发现](testing/2026-10-12/qq-event-result.json)；DNS 环境补丁和资源标识见交接文档。

## 尚未验收/交付

真实 Gmail/Graph 接入、QQ 真实附件及长时间运行；供应商 OAuth app 配置/审批；新服务 webhook 投递；聘钉页面、FastMCP、真实计费与项目入库网关；生产发布。实现与验收材料在 `codex/mail-sync-foundation` 分支交付，生产部署不包含在内。

持续发现是接收时间窗口轮询，不承诺旧日期邮件后迁入/删除的完整镜像。完整范围见 `mail-intake.md`。

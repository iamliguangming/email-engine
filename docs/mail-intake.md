# 聘钉独立邮件服务：项目收件与简历挑选

日期：2026-10-12。实现位于 `src/mail/`；复用 Kadri 的 Gmail、Graph、IMAP 适配器和邮件解析库。独立入口使用 PostgreSQL + pg-boss，不打开旧 SQLite 数据库。旧入口 `npm start` 保留供上游协议回归使用；新服务使用 `npm run start:mail`。

本轮范围经确认：交付独立服务及聘钉接入契约，不修改聘钉 SaaS 页面、积分账本或简历入库代码。商业版参考限于公开接口文档；本实现未复制商业版源代码。

## 用户故事与实际行为

1. **用户绑定一个或多个邮箱。** IMAP 提交主机、用户名、应用密码；Gmail/Microsoft Graph 创建 OAuth 链接，由用户授权。凭证加密存储，连接验证异步执行。账号 ready 仅表示连接可用，不表示历史拉取已完成。
2. **邮箱绑定项目。** 调用者必须拥有邮箱且对项目有写权限；选择服务返回的文件夹 ID。同一邮箱可绑定多个项目，项目之间分别保存匹配设置、待挑选列表和已选记录。
3. **设置规则或 AI 匹配。** manual 模式直接进入待挑选列表；rules 模式执行确定性规则，不调用模型；ai 模式调用聘钉提供的 AI/积分网关。匹配只是推荐，未匹配邮件仍可查看和选入。匹配任务不阻塞邮件拉取。
4. **按时间拉取并人工挑选。** 输入明确的起止时间，按接收时间 UTC `[from,to)` 拉取，逐页显示结果。用户选中附件或正文后先得到 selection 草稿，再用 human 委托确认。确认后通过可靠队列向聘钉交付；Agent 可以准备草稿，不能调用确认代替用户批准。

```mermaid
flowchart LR
  U[用户绑定邮箱] --> A[邮箱连接与授权]
  A --> B[绑定项目和文件夹]
  B --> C[时间区间拉取任务]
  C --> D[(PG 邮件索引和待挑选列表)]
  D --> E[规则 / AI 匹配队列]
  E --> F[推荐结果，含未匹配邮件]
  D --> F
  F --> G[用户挑选附件或正文并确认]
  G --> H[可靠入库交付队列]
  H --> I[聘钉项目简历入库接口]
  E --> J[聘钉 AI 与积分网关]
```

## 接口入口

完整路由及参数模式：`GET /openapi.json`，仓库快照 `docs/mail-api.openapi.json`。重要接口如下：

| 用户任务 | HTTP |
| --- | --- |
| Gmail/Graph 授权 | `POST /v1/connection-sessions` → 用户打开返回的 url |
| IMAP 连接 | `POST /v1/mailboxes` |
| 邮箱列表 / 状态 / 文件夹 | `GET /v1/mailboxes`、`GET /v1/mailboxes/{id}` |
| IMAP 更新密码 / 重新验证 | `PATCH /v1/mailboxes/{id}/credentials`、`POST .../reconnect` |
| 本地断开邮箱 | `DELETE /v1/mailboxes/{id}`，提交 version；停用绑定并清除连接凭证，不删除远端邮件 |
| 绑定 / 设置 / 暂停持续发现 | `POST /v1/bindings`、`PATCH /v1/bindings/{id}` |
| 时间范围拉取 | `POST /v1/bindings/{id}/imports` |
| 查看任务 / 取消 / 重试 | `GET /v1/operations/{id}`、`POST .../cancel`、`POST .../retry` |
| 历史任务列表 | `GET /v1/bindings/{id}/operations`，最新 100 条 |
| 待挑选列表 | `GET /v1/bindings/{id}/messages?limit=25&cursor=...&operation=...` |
| 正文与附件元数据 | `GET /v1/bindings/{id}/messages/{mid}` |
| 下载附件 | `GET .../{mid}/attachments/{index}`，强制附件下载，不渲染 HTML |
| 应用新匹配设置 / 重试失败匹配 | `POST /v1/bindings/{id}/rematch` |
| 保存选择草稿 | `POST /v1/bindings/{id}/selections` |
| 用户确认 | `POST /v1/selections/{id}/confirm`，仅 human 委托 |
| 查看交付 / 重试失败交付 | `GET /v1/selections/{id}`、`POST .../retry` |
| 事件补读 | `GET /v1/events?after=0&limit=100` |

创建邮箱、绑定、拉取、selection、reconnect、rematch 请求使用 `Idempotency-Key`。同主体同路径同 key 同内容返回原结果；同 key 不同内容返回 409。新的业务请求使用新 key。

设置更新使用 `version`；匹配配置另外维护 `matching_version`。暂停/恢复或标记已读不创建新的 AI 计费键；匹配设置变化或用于判断的邮件内容变化会产生新的判断版本。`rematch` 只处理旧版本/失败项，不重复评估已经完成的相同版本。

规则字段：`subject/sender/recipient/snippet/has_attachment`；操作符 `contains/equals`；规则组合 `all/any`。`has_attachment` 只支持 equals true/false。字符串以 Unicode NFKC 规范化并忽略大小写；不执行用户正则表达式。示例：

```json
{
  "mailbox_id": "MAILBOX_ID",
  "project_id": "PROJECT_ID",
  "folders": ["INBOX"],
  "continuous": false,
  "matching": {
    "mode": "rules",
    "rule_logic": "any",
    "rules": [
      {"field": "subject", "operator": "contains", "value": "简历"},
      {"field": "subject", "operator": "contains", "value": "应聘"}
    ]
  }
}
```

时间输入必须带时区，如 `2026-10-01T00:00:00+08:00`；服务统一转成 UTC。拒绝倒置区间和未来结束时间。Gmail 使用 internalDate、Graph 使用 receivedDateTime、IMAP 使用 INTERNALDATE，避免邮件发送日期伪造或回填影响区间含义。

列表按固定创建时间边界和消息 ID 做 keyset 分页，cursor 绑定查询条件；不是数据库快照导出。可用 operation 参数只看某次拉取发现的邮件。每个 mailbox 的 provider ID 是身份基础；IMAP 包含文件夹与 UIDVALIDITY，因此跨文件夹复制可能出现不同待挑选项，首版不声称跨 provider/文件夹语义去重。

## 身份和权限接入契约

部署方保存 `MAIL_ADMIN_TOKEN`；它仅用于 `/admin/*`，不能直接读取业务邮箱，不能给浏览器或 Agent。

1. 聘钉完成自己的会话、组织与项目鉴权后，调用 `PUT /admin/principals` 同步 `{tenant,user,projects:{项目ID:"read"或"write"},enabled,version}`。
2. `POST /admin/delegations` 颁发短期 token，指定 `actor:human|agent`，默认 300 秒、最大 1 小时。actor 必须由聘钉根据可信入口决定，不能透传浏览器/工具参数。
3. SaaS 和 MCP 都用此用户委托调用 `/v1/*`。每次执行实时读取 principal，因此撤项目权限、停用用户或删除 token 后旧 token 也不再有权访问。
4. 后台任务重新检查邮箱所有者状态和项目写权限。Host AI/入库网关还必须再次用 tenant/user/project 查聘钉的真实权限，以防权限同步尚未完成或排队期间撤权。
5. `DELETE /admin/delegations` 按 token 撤销单个委托。组织变化用新 tenant 的 principal；停用旧 principal，不能仅更新工具目录。

个人邮箱和项目审核列表首版仅所有者可见，项目写权限不能读取另一个人的私人邮箱。共享邮箱/同项目多人共享邮件需后续单独定义授权；尚未实现。

## AI 与积分网关

配置固定的 `MAIL_HOST_GATEWAY_URL` 和 `MAIL_HOST_GATEWAY_SECRET`，邮件服务调用 `POST {base}/match`。目标由部署者设置，用户不能修改。

请求包含 `schema_version,tenant_id,user_id,project_id,binding_id,message_id,instructions,message,content_scope,billing_policy`。当前输入仅元数据和 snippet（`content_scope=metadata_and_snippet`），不解析附件内容来做 AI 判断；产品须明确这是邮件相关性推荐，而非完整简历评分。

HTTP 头：

- `Idempotency-Key: match:{binding}:{message}:{matching_version}:{content_hash}`。
- `X-Mail-Timestamp`: Unix 秒。
- `X-Mail-Signature`: `HMAC-SHA256(secret, timestamp + "." + key + "." + 原始请求体)` 的 hex。

聘钉实现以下原子语义：验证签名及时间窗 → 查询幂等回执 → 校验授权与余额 → 执行 AI/扣点并保存结果 → 返回回执。相同 key 的重试返回相同结果和 charge_id，不再次扣点。多项目分别启用 AI 是不同判断任务，可能分别扣点。

成功响应：

```json
{"matched":true,"reason":"应聘邮件，附有简历","charge_id":"ledger-entry-id","credits":1}
```

402 表示余额不足，停止本次自动重试并把匹配标记为 failed；用户充值后调用 rematch。429/5xx/网络失败由队列有限次重试。邮件拉取和规则判断不调用这个计费接口。AI 开启前必须配置网关，否则 API 明确拒绝。

服务本身没有复制聘钉积分账本，也没有真实模型密钥。已验证的是模拟网关的幂等协议，真实扣点与模型调用需要聘钉接入后验收。

## 人工选入与入库交付契约

草稿请求示例：

```json
{"message_id":"MESSAGE_ID","attachment_indexes":[0],"include_body":false}
```

确认时校验附件存在，并保存被选附件/正文的 SHA-256。交付时再次验证内容；变化时返回可见失败，不悄悄导入不同内容。

`POST {base}/import` 使用 `Idempotency-Key: selection:{selection_id}`，签名规则与 AI 相同。请求包含组织/用户/项目、selection_id、message_id、confirmed_at、选中的 text（或 null）以及附件 `{index,filename,content_type,content_base64,sha256}`。

聘钉需将这一步接到既有简历快照/入库管道，落库 selection_id 唯一约束，与创建项目入库任务放在同一事务后再响应。例如：

```json
{"status":"accepted","import_id":"pintalent-import-task-id"}
```

`delivered` 仅说明下游持久化接受，不能展示成“简历已经完成画像/评分”。最终入库进度由 `import_id` 对应的聘钉任务查询；本服务不伪造候选人记录。网关可返回 `completed` 表示它已经完成，但应保留任务引用。

交付超时可能已经被下游接受，必须使用原 selection_id 重试。没有配置网关时，允许保存选择草稿，但拒绝确认；不会把未交付伪装为成功。

## 任务与恢复

- 拉取/验证：`queued → running → succeeded`；失败可进入 `retrying → failed`；支持 `cancelled`。
- 匹配：`manual`，或 `pending → matched/unmatched`；失败有 `retrying/failed`；配置更新会把未完成旧任务标为 `needs_rematch`。
- 选择：`draft → queued → delivered`；失败有 `retrying/failed`，只重试已确认选择。
- 每页邮件索引、审核项、匹配任务、发现事件和拉取游标在同一 PG 事务提交。重试从已提交页继续，不把未提交页当作成功。
- pg-boss 提供持久化领取、最多 3 次重试（加首次共 4 次）、退避、心跳与超时回收。应用校验 job_id/attempt 防止过期 worker 提交旧结果。
- 同一邮箱协议调用使用 PG advisory lock 串行，刷新令牌以密文 compare-and-swap 保存。
- 事件日志用事务内计数器串行分配，避免普通序列号的提交乱序导致消费跳项。cursor 返回字符串；接收方落库后再推进。
- 用户取消不删除已经发现的审核项，也不会撤销已交付的项目入库。任务执行期间修改绑定，旧任务会失败并提示使用当前设置新建拉取，不静默改变用户原请求。
- `continuous=true` 使用每分钟后台调度，按上次完成的接收时间水位回看 10 分钟并去重，不需要 Agent 轮询。失败任务阻止该版本继续堆叠新任务，可恢复后重试。

**持续发现当前是有界时间窗口轮询，不是 Gmail history/Graph delta 的完整增量镜像。** 旧接收时间邮件的后来复制/迁入、远端删除与全量对账不在当前首版保证内；需要用户再次指定历史范围拉取。未实现 provider 原生推送、SSE、通用 Webhook 路由、正文对象缓存和数据保留期自动清理。此前研究文档中列出的全部邮件引擎能力并未因此全部实现。

## 本地运行与部署

要求 Node >=22.12、PostgreSQL 17（验收版本）。

```sh
npm ci
npm run build
cp .env.mail.example .env.mail
# 为数据库密码、MAIL_SECRET、MAIL_ADMIN_TOKEN 分别填写独立随机值。
docker compose --env-file .env.mail -f compose.mail.yml up -d --build
curl http://localhost:8095/health
```

Compose 将 API、worker、PostgreSQL 分开，API 仅映射本机 8095。公开部署需配置 HTTPS 反向代理、可信出口策略及正确 MAIL_PUBLIC_URL；OAuth 回调地址固定为 `{MAIL_PUBLIC_URL}/v1/oauth/callback`。Google 申请 Gmail readonly，Microsoft 申请 Mail.Read/User.Read/offline_access。真实供应商 app 审批不包含在本轮开发中。

`.env.mail` 不入 Git；数据卷独立，配置 MAIL_SECRET 后不可随意更换，否则旧凭证不能解密。备份 PostgreSQL 与密钥需分开保护。服务不把凭证写入普通日志。生产禁用 `MAIL_ALLOW_PRIVATE_HOSTS=true`，私网自建邮箱接入需要先增加运维允许列表；开发测试可用该开关连接本地邮件服务器。

非 Docker 运行使用 `DATABASE_URL,MAIL_SECRET,MAIL_ADMIN_TOKEN`，可设 `MAIL_ROLE=api|worker|all`；默认 all。不配置网关/OAuth 时可以启动健康检查与已有 API，但对应能力明确返回 unavailable。

## MCP

```sh
MAIL_URL=http://127.0.0.1:8095 MAIL_DELEGATED_TOKEN=用户的agent委托 npm run mcp:mail
```

提供账号列表、授权链接、项目绑定和更新、时间范围拉取、任务查询/取消/重试、匹配重试、邮件列表和内容、选择草稿及交付状态。薄封装同一 HTTP API；没有管理员 fallback，也没有 human confirm 工具。Agent 不需要监控任务到结束，应将任务 ID 交还页面/后台事件处理。

聘钉后续仍需在现有 FastMCP 内挂载面向当前用户的业务工具，不能把这个独立 stdio 客户端当作已经完成聘钉平台接入。

## 自动化验收与范围

```sh
npm test
MAIL_TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:55439/mail npm run test:mail
```

集成测试会创建随机 `mail_test_*` 数据库并在结束后删除，只能给隔离测试实例授予 CREATEDB；不能对生产执行。缺少变量时 PG 集成测试会明确 skip。

覆盖：三种 provider 区间语义与附件识别、SQLite 旧功能回归、真实 PostgreSQL 与 pg-boss、队列重启续跑、事务回滚、分页失败恢复/取消、持续发现和不重复扣费、OAuth PKCE/身份校验/单次回调、跨组织与无项目写权限/撤权、人工确认、确认后内容校验、实际 MCP stdio 发现与读写错误。

状态：独立 HTTP 服务和 MCP 已实现并做合成数据自动化验证；聘钉 SaaS 页面、真实 AI 点数、真实项目候选人入库及真实 Gmail/Microsoft/QQ 邮箱长稳验收尚未接入。未发布生产、未提交或推送。

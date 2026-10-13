# 邮件引擎核心接口规范与实现路线评估

日期：2026-10-12。状态：设计草案，尚未实施。目标是支撑 PinTalent 的个人多邮箱接入、项目绑定、历史导入与持续同步。

结论：继续基于 Kadri fork 开发，保留协议适配器、解析与模拟测试，重构存储、同步事务、账号生命周期和事件投递。核心技术栈拟采用 Node.js、PostgreSQL、pg-boss。不承诺商业 EmailEngine 全量功能或接口直接替换兼容。

## 1. 对标范围与证据

- 商业版行为来自公开产品文档；未使用商业版实现代码编写本规范，也未运行商业版做黑盒验收。
- 商业仓库仅下载做机械文件/行数统计，并读取版本与提交元数据；未安装依赖或运行其脚本。
- Kadri 依据当前 fork `197ca43f4fd979e3fb9a22505cecb694b57b30a8` 的实际接口和实现；上游基线为 `f2f4bac6e86d39aed105f21486da37e589537d12`。
- 以下“商业版”是已公开行为；“目标规范”是我们的设计决定，不能当作已有实现。商业文档是滚动更新页面，不保证每条行为都对应此次统计的代码版本。
- 商业版源代码公开但采用商业许可证。独立实现以公开接口行为和协议标准为依据；可复用库逐项核对许可证。

## 2. 核心场景与产品边界

用户在个人设置中绑定多个邮箱，在有权限的项目中选择一个或多个邮箱/文件夹和历史时间范围。历史邮件导入与新邮件跟踪可以同时推进，用户能看到进度、失败原因，暂停或恢复。附件解析、候选人入库、画像与评分继续由 PinTalent 后台任务处理。

邮件引擎负责连接、同步、邮件索引、正文/附件读取和可靠事件交付。PinTalent 负责用户、组织、项目成员、邮箱共享授权、项目绑定和业务处理结果。

同一邮箱连接可以服务多个经授权的项目，但项目解绑不能删除仍被其他项目使用的连接。不能把邮箱地址当作用户/组织所有权的唯一键。连接凭证更新、共享授权撤销和删除要分别定义。

首版支持范围：Gmail API、Microsoft Graph（Microsoft 365/Outlook 场景）、通用 IMAP；QQ 和企业自建邮箱通过其实际开放的 IMAP 能力验收。SMTP 是发送协议；inbound SMTP 是转发接收入口；POP3、Exchange 本地部署的 EWS 不因已有 IMAP/Graph 而自动获得支持。后两者暂不承诺，需按客户实际服务器另行评估。

首版不追求营销群发、模板平台、退信分类、点击跟踪、IMAP 代理、完整邮箱客户端或分布式邮箱调度。已有发送/动作能力保留并执行权限测试，但扩展发信产品不列入首版范围。

## 3. 商业版公开接口对照

### 3.1 账号与授权

| 商业版公开接口 | 对外用途 | Kadri 现状 |
| --- | --- | --- |
| `POST /v1/authentication/form` | 生成用户接入或重新授权链接 | 无产品级流程；当前用脚本取得 refresh token |
| `POST /v1/verifyAccount` | 验证 IMAP/SMTP 参数 | 无独立接口 |
| `GET/POST /v1/autoconfig` | 发现邮箱配置 | 无 |
| `POST /v1/account` | 注册账号 | `POST /accounts` 可提交配置 |
| `GET /v1/accounts`、`GET /v1/account/{account}` | 列表、详情与状态 | 有列表，无独立详情及分页 |
| `PUT/DELETE /v1/account/{account}` | 更新、删除连接 | 同地址 POST 可覆盖配置，无明确删除入口 |
| `PUT .../reconnect`、`PUT .../sync` | 请求重连、同步 | 无独立接口 |
| `GET /v1/changes` | 账号状态 SSE | 有更广泛的引擎事件 SSE，但语义不同 |

商业版区分临时连接问题和鉴权失败；授权链接支持限制目标邮箱，重新授权可恢复已有连接。它的账号接口权限还区分普通读取和会改变凭证目的地的配置操作。[账号 API](https://learn.emailengine.app/docs/api-reference/accounts-api)、[授权接入](https://learn.emailengine.app/docs/accounts/hosted-authentication)

重要纠正：`accountInitialized` 对 IMAP 是首次遍历文件夹后就绪；对 Gmail/Graph 是 provider profile 检查成功后就绪，不代表完成全部历史邮件导入。不能直接把它用作我们“历史入库完成”的信号。[初始化事件](https://learn.emailengine.app/docs/webhooks/accountinitialized)

### 3.2 邮件读取与操作

| 商业版公开接口 | 对外用途 | Kadri 现状 |
| --- | --- | --- |
| `GET /v1/account/{account}/mailboxes` | 文件夹列表 | `/accounts/:id/folders` |
| `GET .../messages` | 分页邮件列表 | 无；全文搜索不能替代列表 |
| `POST .../search` | 结构化条件搜索 | `/search?q=&tag=&limit=`；只有本地全文/标签和数量限制 |
| `GET .../message/{message}` | 邮件详情 | `/messages/:id` |
| `GET .../text/{text}` | 正文 | `/messages/:id/body`，按需拉取解析 |
| `GET .../attachment/{attachment}` | 下载附件 | `/messages/:id/attachments/:index` |
| `GET .../message/{message}/source` | 下载原始邮件 | 适配器内部可取，HTTP 未开放 |
| `PUT .../message/{message}`、`.../move`、`DELETE .../message/{message}` | 标记、移动、删除 | 统一通过 `/actions`；不是 URL 兼容实现 |
| `POST .../submit` | 异步提交发送 | 有 send action，无同等完整的发信队列管理 |

商业版列表按文件夹分页；筛选条件走 search，分页能力和总数精度因 provider 而异。正文可按请求读取，支持大小限制；原始邮件与附件单独下载。我们不复制这些 provider 差异作为目标契约，而对本地索引提供明确统一行为。[邮件 API](https://learn.emailengine.app/docs/api-reference/messages-api)、[结构化搜索](https://learn.emailengine.app/docs/receiving/searching)

商业版 submit 成功表示进入发送队列，最终状态通过 outbox 和事件跟踪。我们也应区分“已接受”和“已完成”，但发信队列扩展列为后续阶段。[发送 API](https://learn.emailengine.app/docs/api-reference/sending-api)

### 3.3 事件、Webhook 与 MCP

商业版把通知放入队列；公开文档写明最多 10 次尝试（含首次）、指数退避、抖动、请求超时、失败查看，要求接收端持久化后确认并按事件 ID 去重。当前 Kadri 只有环境变量单地址、直接 HTTP 和一次内存重试。[通知机制](https://learn.emailengine.app/docs/webhooks/overview)

商业版有 HMAC 签名、账号覆盖地址和自定义路由。我们的首版仅需固定的 PinTalent 内部目标及账号/事件筛选，不引入用户提供的任意执行脚本。[Webhook API](https://learn.emailengine.app/docs/api-reference/webhooks-api)

商业版已经有 MCP，复用 REST 鉴权并按凭证过滤工具；Kadri 的 stdio MCP 包装 HTTP，但目录静态，账号管理工具缺失，且部分读路由没有落实 action 权限检查。[商业 MCP](https://learn.emailengine.app/docs/mcp)、[商业访问令牌](https://learn.emailengine.app/docs/api-reference/access-tokens)

商业版 `messageNew` 是“文件夹中新发现邮件”，移动或复制也可能产生；不等于新的外部来信。Kadri 尝试跨文件夹保持邮件 ID，此设计可保留，但须验证碰撞、复制和重编号。[商业事件语义](https://learn.emailengine.app/docs/reference/webhook-events)

## 4. 我们的目标接口规范

以下全部为拟定接口，前缀为 `/v1`；首版不做商业 API 逐字段兼容。已有内部客户端迁移或经薄适配层过渡，不能维护两套鉴权与业务逻辑。

### 4.1 通用约定

- 账号、邮件、附件、事件均使用服务生成的稳定不透明 ID。提供方原始 ID 单独存储，不让调用方推导其编码。
- 普通同步查询返回 200；创建资源返回 201；后台操作返回 202 和 `operation_id`。HTTP 成功不代表邮件已同步或业务已入库。
- 修改操作支持 `Idempotency-Key`：按租户/调用主体和操作范围约束，同键同请求返回原结果，同键不同请求返回 409。不得返回其他账号的缓存结果。
- 长任务状态：`queued/running/succeeded/failed/cancelled`，可重试失败记录原因和重试关联；取消只影响尚未完成的工作，不自动撤回已生效的外部操作。
- 错误统一为 `error.code/message/retryable/request_id`，可带 `fields` 和 `retry_after_seconds`。不输出凭证、provider 原始认证响应或无关邮件正文。
- 校验错误 400，失效凭证 401，无操作权 403；不可见资源按统一策略 404；版本/幂等冲突 409；游标过期 410；限流 429；暂时不可用 503。
- 可变配置返回 `version` 并做条件更新；授权撤销、连接身份变化和版本冲突必须在后端落实。
- OpenAPI 描述 HTTP；MCP 由相同业务服务提供，不能另写简化鉴权。凭证填写和 OAuth 同意由用户完成，Agent 只生成接入链接和查看状态。

### 4.2 账号与接入

| 拟定接口 | 核心参数/结果 | 行为要求 |
| --- | --- | --- |
| `POST /connection-sessions` | provider、redirect target、可选既有 account_id、expected_email；返回 url、expires_at | 绑定当前委托身份，单次短效会话，校验 state/回调，目标地址白名单；重新授权失败不得覆盖旧连接 |
| `POST /accounts/verify` | IMAP 参数及凭证；返回各能力校验结果 | 不创建长期连接记录；限制目标网络和超时，凭证不进日志 |
| `POST /accounts` | provider 配置；返回 account_id、operation_id | 可信后端创建，连接和初次同步异步进行，不以 email 全局覆盖别人的连接 |
| `GET /accounts`、`GET /accounts/{id}` | 分页、账号详情 | 只返回授权账号；凭证不回传；状态、最近成功时间、下一次重试与可恢复原因分开 |
| `PATCH /accounts/{id}` | 允许修改的配置及 version | 更换 host 不能悄悄向新目的地发送旧密码；敏感配置使用专门授权路径 |
| `POST /accounts/{id}/reconnect` | 幂等键；返回 operation_id | 瞬态错误可重连；凭证撤销必须要求重新授权，不无限重试 |
| `POST /accounts/{id}/sync` | incremental/reconcile；返回 operation_id | 同账号串行或合并重复请求；与历史导入任务区分 |
| `POST /accounts/{id}/pause`、`/resume` | version、幂等键 | 幂等；保留同步位置；恢复先验证凭证再补拉 |
| `DELETE /accounts/{id}` | version；返回清理操作 | 先停任务并撤销访问；本地保留/删除策略明确；不删除远端邮箱中的邮件 |
| `GET /operations/{id}`、`POST .../cancel`、`POST .../retry` | 状态、阶段、计数、错误 | 只作用于自身允许操作；retry/cancel 是否支持由操作类型声明 |

账号连接状态与历史导入状态分别建模。`ready` 表示可调用邮箱；历史任务的 `succeeded` 才表示所选范围已经枚举并可靠写入。total 未知时返回 null，不能伪造百分比。

### 4.3 列表、搜索与内容

| 拟定接口 | 核心参数/结果 | 行为要求 |
| --- | --- | --- |
| `GET /accounts/{id}/folders` | folder_id、parent_id、role、provider_path | 支持层级和角色；角色不等于本地化名称 |
| `GET /accounts/{id}/messages` | folder_ids、limit、page_cursor；items、next_cursor、as_of、index_state | 查询本地索引，稳定排序；权限过滤先于 limit；未索引不冒充空邮箱 |
| `POST /accounts/{id}/messages/search` | from/to、subject、时间范围、seen、has_attachments、text、tags | 明确索引搜索范围，未缓存全文不声称搜过完整正文；不支持的条件明确拒绝 |
| `GET /accounts/{id}/messages/{mid}` | 元数据、version、folder_ids、body_state | 校验账号与资源关系，不把知道 ID 当作授权 |
| `GET .../{mid}/body` | text/html、max_bytes；truncated、content_version | 默认不改变已读；展示 HTML 清洗，下载原始内容单独区分 |
| `GET .../{mid}/attachments`、`GET .../{mid}/attachments/{aid}` | 附件元信息与二进制 | attachment_id 与内容版本关联；缓存不可绕过权限；类型、大小、超时受控 |
| `GET .../{mid}/source` | EML 流 | 可选保留策略；远端已删除且未缓存时明确 unavailable，而非空正文 |

分页游标绑定账号、筛选条件、排序、索引代次与边界。首版保证按固定索引边界遍历、结果按 ID 去重，并由事件追赶弥补并发变化；不承诺未经实现的数据库快照一致性。需要严格导出快照时另建持久化导出任务。旧游标不能在改变筛选或授权范围后继续使用。

正文/附件存储建议与 PG 元数据分离，用受控对象存储；一期可保留按需抓取，但展示可用性和过期状态。后续缓存任务也可用 pg-boss，不能与长时间 AI 任务共用执行资源。

### 4.4 历史导入与事件消费

- `POST /accounts/{id}/imports` 创建选定文件夹和日期范围的历史导入任务，返回 operation_id；计数区分 scanned、indexed、failed，不把“入队”计为完成。
- 任务记录开始时的同步边界，历史枚举和增量追赶交接必须无空窗；先可靠写入发现结果，再推进检查点。
- 用 `origin=backfill/live/reconcile` 标明事件来自何种发现过程；这是同步来源，不是绝对的“邮件刚刚送达”证据。邮件日期另有字段，移动/复制不能自动算新投递。
- `GET /events?after=...&limit=...` 返回授权范围内事件、服务端扫描 next_cursor；即使事件数组为空，也可能因权限过滤而推进扫描位置。
- `GET /events/stream` 提供实时提示和断线续读；接收方只有在事件可靠落库后才更新自己的消费位置。SSE 发送成功不代表业务已处理。
- 新绑定项目需要独立历史导入，不能依赖已有账号的实时事件再次重放全部存量。
- 明确事件保留期、最早可读位置；过期游标返回 410 和重新对账方案，不默默跳到最新。

必须分开三类位置：provider_sync_state（内部同步）、page_cursor（列表）、event_cursor（消费）。event_id 是稳定去重标识；event_cursor 表示日志位置，不能代替事件处理完成标识。对外用不透明字符串，避免 JS bigint 精度和实现绑定。

事件建议包含：event_id、schema_version、type、account_id、message_id（适用时）、resource_version、occurred_at、observed_at、origin、payload。订阅投递还带 delivery_id/attempt。发生时间未知时不得拿发现时间伪装精确送达时间。

### 4.5 可靠投递与数据库事务

- `POST/GET/PATCH /webhook-subscriptions`：目标、账号/事件范围、启停；首版仅管理员配置固定内部目标。
- `GET /webhook-deliveries`、`GET .../{id}`、`POST .../{id}/retry`：查询结果和补发；补发使用原 event_id，不能生成新的业务事件。
- 同一 PG 事务保存邮件变更、事件和 pg-boss 任务；显式使用同一数据库事务连接。不能先 commit 邮件再另行 enqueue。
- pg-boss 管理领取、超时恢复与重试；审计记录保存 attempts、last_error、next_attempt_at 和最终状态。只设一个重试调度权威，避免手工定时器和队列各自重试。
- 只在事务提交后对外发送。Worker 网络等待放在数据库事务外；故障恢复允许重复投递，不承诺 exactly-once HTTP。
- HMAC 对原始请求体和时间戳/事件标识签名；目标密钥可轮换。接收方验签、唯一约束去重、持久化接受后返回 2xx。
- 网络故障、429、5xx 退避重试；尊重有上限的 Retry-After。鉴权/配置错误进入可见的待修复状态，修复后补发。具体次数/窗口是我们的配置，不照搬商业默认值。
- 耗尽重试后保留失败状态，告警并允许重放；任务历史清理不等于业务事件清理。
- 事件游标提交顺序需要单独保证：首版可用事务内事件计数器行锁，使短写事务的事件分配和提交串行化。普通 BIGSERIAL 不足以保证提交顺序；不能在持锁时访问邮箱/HTTP。

pg-boss 支持事务内入队和至少一次执行；这能替代自建领取/重试调度，但不能替代业务幂等和事件日志一致性。[pg-boss 官方说明](https://pgboss.io/introduction)

### 4.6 PinTalent SaaS 与 MCP 交付

| 用户任务 | SaaS 入口 | MCP 业务工具建议 |
| --- | --- | --- |
| 绑定/重新授权邮箱 | 个人邮箱设置 | begin_mailbox_connection，返回用户授权链接 |
| 查看连接及恢复 | 个人邮箱状态 | list_mailboxes、get_mailbox_status、request_mailbox_reconnect |
| 绑定项目收件范围 | 项目邮件设置 | bind_project_mailbox、update_project_mailbox_binding、unbind_project_mailbox |
| 历史导入及状态 | 导入任务页 | start_project_mail_import、get_mail_import、retry/cancel_mail_import |
| 查找邮件和附件 | 项目邮件列表/详情 | search_project_mail、get_project_mail、get_mail_attachment |

工具名为提议，按任务组合而非一 API 一工具。邮箱引擎的 admin token 不给用户 Agent；PinTalent MCP 使用当前有效委托身份，共用 SaaS 业务服务与授权。输入中的 user_id/org_id 不能决定调用者身份。跨组织、无项目访问权、只读用户、非邮箱所有者及撤权都需拒绝测试。后台连续同步依据经授权且可撤销的绑定，不依赖 Agent 持续轮询或聊天会话保持在线。

## 5. Kadri 改造清单

| 优先级 | 内容 | 保留与修改范围 | 验收重点 |
| --- | --- | --- | --- |
| P0 | 连接身份与授权边界 | 改全局 email 唯一覆盖；补读写 action、文件夹和任务权限 | 跨账号/组织、撤权、缓存结果不能越权 |
| P0 | PG 存储与异步调用链 | 重写 store 接口/SQL/事务；同步 sink、scope、API 适配 async | 同事务、回滚、并发冲突、数据库恢复 |
| P0 | 同步一致性 | 保留协议增量思路；重写变更提交与 checkpoint 流程 | 更新与事件原子性；lost 删除判定落库；失效游标全量对账 |
| P0 | pg-boss 投递 | 替换直接 deliver；增加审计、签名和失败恢复 | kill Worker、超时、重复 HTTP、补发 |
| P0 | 接入和连接生命周期 | 增加授权会话、验证、详情、暂停/恢复、解绑 | 授权失败不覆盖旧配置；停止自动重试死凭证 |
| P0 | 分页列表和历史导入 | 新增列表、任务、扫描边界、进度与查询筛选 | 列表变化时不丢业务候选项；历史/实时衔接 |
| P0 | 正文附件闭环 | 保留解析器；修 Gmail 附件标记，开放原文；限制资源消耗 | 真附件下载、provider删除后的明确状态 |
| P0 | PinTalent 项目绑定与 MCP | 新业务层，不能仅复用底层 scope 代替项目权限 | SaaS/MCP 对同一资源允许与拒绝一致 |
| P1 | Gmail/Graph 原生推送 | 补 Pub/Sub、Graph subscription 注册/续期/校验 | 通知丢失仍能轮询补齐，续期失败可见 |
| P1 | 目录/全文/缓存完善 | Graph 子文件夹、中文搜索策略、正文对象缓存 | 内容范围和查询语义明确 |
| P1 | 管理可观测性 | lag、最老待投递、账号错误率、阶段耗时 | 告警能定位账号/任务且不泄露正文和凭证 |
| P2 | 发信、模板、共享邮箱等扩展 | 根据实际用户需求分批做 | 不拖慢核心收件上线 |

当前已验证：18 项单元测试、Gmail/Graph 模拟链路各 26 项通过、6 项实际 MCP 测试；这些不能证明真实 provider 长稳、所有权限边界或精确崩溃窗口。JMAP/inbound/IMAP 的代码存在，不把此前其他环境的上游报告视为本分支已全面验收。

## 6. 必须加入的故障验收

1. 写邮件前后、写事件前后、入队前后强制退出：提交结果必须全有或全无；重启能继续。
2. 更新标记后尚未写事件就退出：不能因状态相同而永久跳过通知。
3. 删除/跨文件夹移动判定中退出：重启能恢复，不误删也不漏删。
4. Gmail history/Graph delta 失效：完成全量差异对账；扫描中途失败不得删除未扫描对象。
5. 相同 Message-ID 不同内容、复制、移动、UIDVALIDITY 变化：区分身份与 provider 位置。
6. provider 列表翻页时有新增/删除：验证历史与增量交接；不能只测静止邮箱。
7. Webhook 已收但回包丢失：多次投递只产生一次业务接收记录和一次对应业务任务。
8. Worker 被杀、数据库重启、broker/队列表暂不可用：恢复后补齐，持续失败最终可见。
9. 并发事件事务乱序完成：消费 cursor 不跳过晚提交事件。
10. 绑定项目后撤销授权、退出组织、只读账号、跨项目访问、已缓存附件：SaaS/MCP 同样拒绝。
11. 无效/过期授权会话、错误邮箱、凭证轮换、配置版本冲突：不污染有效连接。
12. 真实 Gmail、Microsoft 365、QQ IMAP 各完成存量、新增、删除、断线与重新授权验收；自建 IMAP 用可控服务器注入边界。

## 7. 基于 Kadri 还是从头写

### 可直接保留的价值

协议适配器的接口与基础增量逻辑、邮件解析和身份/线程处理的起点、OAuth 刷新基础、模拟 Gmail/Graph 服务、跨 provider 场景测试、HTTP/MCP 共用入口。它们都需要审查和扩充，但从空仓库重新组织这些行为仍然有成本。

### 不应为了兼容而保留的部分

同步式 SQLite Store、状态变更与事件分散提交、内存 lost 集合承担恢复责任、直接 Webhook、全局邮箱地址作为连接唯一身份、含混的权限空列表语义。统一替换这些边界比继续叠补丁更划算。

| 判断维度 | Kadri 上重构 | 从头实现（仍使用成熟协议库） |
| --- | --- | --- |
| 最早跑通三类邮箱 | 已有适配器和模拟服务，较快 | 需要重新定义与打通连接、映射、同步 |
| PG/队列/生命周期 | 都要做，存在同步转异步的迁移成本 | 可原生设计，无旧接口包袱 |
| 可靠性验证 | 可以复用测试设施，但缺口需补 | 同样要补故障与真实 provider 验收，不能因新代码少而省略 |
| 长期复杂度 | 若明确替换核心边界，可控制 | 初期干净，后续会重新遇到邮件边界问题 |
| 当前数据迁移负担 | 没有真实生产邮箱数据，较低 | 同样较低 |
| 商业版全量对齐 | 不在当前范围 | 同样不在当前范围 |

建议：保留 fork 与许可证历史，以模块为单位替换核心，不从空仓库重建。若短期技术验证发现协议层无法脱离同步存储，或真实 provider 行为反复偏离，再考虑保留测试/工具库、重建协调器；不预先承诺保留每个文件。

### 工作量估算

以下是人工工程人日的规划区间，不是 AI 执行时间或交付承诺。假设一名熟悉 Node/PG/邮件集成的工程师，范围为上述首版收件能力；不含 OAuth 平台审批等待、客户 Exchange 特殊配置、生产历史数据迁移、完整商业兼容或横向扩容。需要短期技术验证后重新估算。

| 工作包 | Kadri 改造 | 从头写 |
| --- | --- | --- |
| 数据模型、PG、事务、队列 | 4–7 | 6–10 |
| 协议接入、同步与恢复 | 6–10 | 10–16 |
| 授权、账号 API、列表/内容 API | 4–6 | 4–6 |
| 契约、错误、MCP 基础与诊断 | 3–5 | 3–5 |
| 故障注入、真实邮箱、部署验证 | 5–8 | 7–12 |
| 邮件服务小计 | **22–36** | **30–49** |
| PinTalent 页面、项目绑定、权限及业务 MCP（两者都需） | 4–8 | 4–8 |
| 含产品接入合计 | **26–44** | **34–57** |

中值比较约少四分之一工作量，可信度中低；未知 provider 兼容问题可能吞掉这部分收益。不能用代码行数倍数推算实现时间。对从头写的估算也不是重写 IMAP/SMTP 协议栈。

建议第一个技术验证只完成：PG 异步 Store + 一条 Gmail mock 的新增/更新/删除事务路径 + pg-boss 投递 + 强制退出恢复。通过后再扩展账号、分页和全部 provider，避免同时改所有层后无法定位回归。

## 8. 商业版当前代码规模

统计时间：2026-10-12；官方仓库版本 **2.83.2**，提交 **5acd8dcfcd7ed6cd4c9b11dc88e568e84751f641**，提交时间 2026-10-10T18:56:10+03:00。固定提交链接：[商业版仓库](https://github.com/postalsys/emailengine/tree/5acd8dcfcd7ed6cd4c9b11dc88e568e84751f641)。Kadri 统计为本 fork `197ca43`，不是未经修改的上游。

使用 cloc 2.06 对 Git 跟踪文件做统计，code 排除空行和注释。未安装 node_modules；按目录和语言区分程序、测试、模板与数据。cloc 的 code 字段对 JSON/Markdown 也计非空行，因此不能把全仓合计叫“业务代码量”。

| 类别 | 商业版文件数 | 商业版 code 行 | 口径 |
| --- | --- | --- | --- |
| 主服务代码 | 240 | **70,428** | lib + workers + server.js + bin/emailengine.js 中 JS/Lua；排除 lib/imapproxy/imap-core 子树 |
| 顶层 test 下 JavaScript | 330 | **59,085** | 含测试脚本及 JS 测试数据，不含 JSON golden fixtures；不是测试用例数量 |
| 管理界面模板 | 168 | **11,614** | views 下识别到的文件 |
| 内含 imap-core 子树 | 74 | **17,833** | 单列整个子树，包含其中测试/文档，不混入主服务代码 |
| 静态资源 | 56 | **16,846** | 含前端脚本、样式及第三方静态内容，不声称全为自研 |
| 其他 | 79 | **50,277** | 锁文件、JSON fixtures、翻译、配置、文档等 |
| 全部 cloc 识别内容 | 947 | **226,083** | 另有注释 36,954、空行 35,578；合计物理行 298,615 |

Git 跟踪文件共 1,060；不是全部都属于可识别文本，二进制、不识别内容与重复处理等会导致 cloc 文件数不同。

| Kadri fork 类别 | 文件数 | code 行 |
| --- | --- | --- |
| src 下生产 TypeScript，排除 *.test.ts | 15 | **3,654** |
| src 单元测试 | 4 | 223 |
| test 下 JavaScript | 15 | 1,706 |
| 全部识别内容，含锁文件/规范/报告 | 54 | 12,051 |

主服务口径约为 19.3 倍，但商业版还承担管理 UI、发送、代理、OAuth 管理、诊断等更多功能，且两边依赖库承担的工作不同。这个比例说明产品厚度差异，不能解释成 Kadri 已覆盖 5% 或补齐需要 19 倍成本。

原始统计和分组脚本位于同目录 `metrics/`，可以用 cloc 2.06 和对应提交复算。未将商业版源码复制进本 fork。

## 9. 当前交付状态

本次交付为接口与行为草案、缺口清单、工程路线与代码规模报告。PG、pg-boss、账号接入、项目绑定以及新 SaaS/MCP 功能均未在本次实施、测试或部署；当前 fork 仍使用 SQLite。后续每个阶段需要分别报告 HTTP/SaaS、MCP、权限、故障恢复和部署验收状态。

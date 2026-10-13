# 聘钉邮件服务背景 核心接口与测试交接

更新日期：2026-10-13。适用读者：接手邮件服务开发、测试和聘钉业务接入的同事。

**我们要解决的是招聘项目持续接收和挑选邮件中的简历，而不是再做一个完整邮箱客户端。** 当前独立服务已经跑通 QQ IMAP 实邮接入、按时间拉取、分页与正文读取、自动发现和事件持久化。最重要的未完成项是可靠 webhook 主动投递，以及聘钉页面、真实用户权限、积分和人才入库管道的接入。

仓库：[iamliguangming/email-engine](https://github.com/iamliguangming/email-engine)。当前开发分支：[codex/mail-sync-foundation](https://github.com/iamliguangming/email-engine/tree/codex/mail-sync-foundation)。下文文件链接全部相对仓库文档组织，在该分支及固定提交页面中均可导航；接手时不要只看尚未合并的默认分支。

本轮服务实现固定版本：[`c1f009b`](https://github.com/iamliguangming/email-engine/commit/c1f009bef4e27bf161b4c5ee6b8787bb46d2e161)。

## 一 为什么开始这项工作

聘钉已有项目、人才库、画像和评分流程，但用户的招聘邮件分散在个人或企业邮箱中。我们希望用户在系统中接入自己的邮箱，把邮件和项目联系起来，既能回溯过去收到的简历，也能持续接收后续来信，而不需要反复手工下载和上传附件。

最初调研关注两件事：第一，跨邮箱服务商复用协议和 API 接入，覆盖 Gmail、Microsoft 365、QQ 和开放 IMAP 的企业邮箱；第二，同时提供可分页的存量读取和可靠的新邮件事件，让聘钉后台完成增量处理，不依赖聊天 Agent 长时间轮询。

我们先调研已有库和服务，避免重新实现邮箱协议。商业 EmailEngine 的生产许可成本不符合当前阶段的预算，因此选择基于 Kadri 的 Apache-2.0 项目迭代。商业 EmailEngine 的公开文档用来对照接口和行为，不能把“源码可查看”理解成可以直接复制其商业实现。更早的 Mail-Archiver 等调研背景并不改变本轮范围：这里交付的是邮件接入服务，而非邮件归档产品。

技术路线是复用 Kadri 的 IMAP、Gmail、Graph 适配器及邮件解析能力，新增 PostgreSQL 存储和 pg-boss 后台任务，把连接、拉取、匹配和业务交付分开。设计沿革见 [核心接口与路线评估](research/2026-10-12/core-api-and-build-assessment.md)；其中的目标接口是历史设计，不代表已经实现，实际契约以本文、[服务说明](mail-intake.md) 和 [OpenAPI](mail-api.openapi.json) 为准。

## 二 已确认的用户故事

1. 用户绑定一个或多个自己的收件邮箱，凭证由服务安全保存。
2. 用户将邮箱绑定到有权限的招聘项目，并选择要读取的文件夹。
3. 用户设置确定性规则，或开启 AI 匹配。规则不消耗 AI 点数；AI 匹配通过聘钉接口执行并按幂等键扣点。
4. 用户设置接收时间区间，拉取历史邮件；查看匹配推荐，再手动挑选正文或附件进入项目人才库。开启持续同步后，新增邮件继续进入同一待挑选流程。

**匹配只是推荐，不自动导入人才库；未匹配邮件仍然可看、可选。** 用户确认之后才向聘钉交付，画像、评分和最终入库由聘钉已有管道负责。首轮范围明确为“独立服务及接入契约”，没有顺带改造聘钉线上页面。

个人邮箱首版仅所有者可见。项目写权限不等于能读取项目中其他人的私人邮箱；共享邮箱和项目多人共享邮件还需明确授权模型。

## 三 我们最重视的接口

优先级按业务接入顺序排列。所有 `/v1/*` 业务请求均需有效用户委托，OAuth 回调通过短效 state 校验；管理凭证仅用于可信后端的 `/admin/*`。

| 能力 | 当前接口 | 为什么重要及验收重点 |
| --- | --- | --- |
| 绑定邮箱与授权 | `POST /v1/mailboxes`；`POST /v1/connection-sessions` | IMAP 使用客户端授权码，Gmail/Graph 使用 OAuth；不把密钥交给 Agent。创建成功仅表示接受验证任务 |
| 连接状态与恢复 | `GET /v1/mailboxes`、`GET /v1/mailboxes/{id}`；`PATCH /v1/mailboxes/{id}/credentials`；`POST /v1/mailboxes/{id}/reconnect` | 能识别 ready、授权失效和失败；重连不能覆盖他人的邮箱。文件夹列表由详情返回 |
| 邮箱绑定项目 | `POST /v1/bindings`、`GET /v1/bindings`、`PATCH /v1/bindings/{id}` | 每个项目独立设置文件夹、匹配和持续同步；修改带 version；个人邮箱归属和项目写权限同时成立 |
| 存量区间拉取 | `POST /v1/bindings/{id}/imports` | 接收时间 `[from,to)`；接受后返回任务，后台分页；历史导入不能依赖新邮件事件“再发生一次” |
| 任务可观测与恢复 | `GET /v1/operations/{id}`；`POST /v1/operations/{id}/retry`、`.../cancel` | 明确排队、运行、成功、失败、取消；失败后可恢复，不能把 HTTP 202 显示成完成 |
| 批量列表和人工浏览 | `GET /v1/bindings/{id}/messages?limit=25&cursor=...&operation=...` | 稳定分页，可限定一次历史任务；返回未匹配项，不只返回推荐项；cursor 不能当作 provider 同步水位 |
| 正文与简历附件 | `GET /v1/bindings/{id}/messages/{mid}`；`GET .../{mid}/attachments/{index}` | 正文和附件元数据按需读取，二进制另行下载；读取不等于批准入库；真实附件仍需验收 |
| 增量发现与事件补读 | 绑定设置 `continuous=true`；`GET /v1/events?after=...&limit=100` | 后台发现邮件，持久化 `mail.discovered`；消费方落库后推进游标；恢复时能补读、能去重 |
| 可靠主动通知 | **通用 webhook 尚未实现，没有可调用的投递接口** | 这是最需要补齐的接入能力：把新事件主动送到聘钉，支持签名、重试、失败查询和重放 |
| 规则或 AI 推荐 | 绑定的 `matching`；`POST /v1/bindings/{id}/rematch` | 拉取与 AI 解耦；规则免费；AI 同一判断版本重试不重复扣点，变更规则可重评 |
| 用户挑选与确认 | `POST /v1/bindings/{id}/selections`；`POST /v1/selections/{id}/confirm` | 先草稿后人工确认；Agent 只能准备草稿；未确认不触发人才入库 |
| 入库交付结果 | `GET /v1/selections/{id}`；`POST /v1/selections/{id}/retry` | delivered 只表示聘钉已可靠接受，不能冒充画像、评分全部完成；重试不得重复创建候选人 |

### 存量同步最小调用链

```text
连接邮箱 → 查询验证任务直到成功 → 读取文件夹
→ 创建项目绑定 → 提交时间区间拉取
→ 查询任务和分页邮件 → 按需读取正文或附件
→ 用户挑选 → 人工确认 → 查询交付结果
```

时间输入必须含时区。例如拉取请求为：

```json
{"from":"2026-10-05T00:00:00+08:00","to":"2026-10-12T00:00:00+08:00"}
```

新请求使用新的 `Idempotency-Key`，重试原请求复用原 key 和请求体。创建邮箱返回 `mailbox_id`、`operation_id`；拉取接口返回操作对象，其 `id` 用于任务查询。不要假设所有异步接口的 ID 字段名称完全相同。

### 增量事件的真实边界

当前后台每分钟调度，按接收时间水位回看 10 分钟并去重。`GET /v1/events` 返回 `events` 和 `next_cursor`，事件包含 `event_id`、`sequence`、`type`、身份范围、payload 和记录时间。`mail.discovered.payload` 可关联 `binding_id`、`message_id`、`operation_id` 和 `origin`，区分历史拉取 `backfill` 与持续发现 `live`。

这条链路已经实测，但 **事件补读接口不是 webhook 推送**。新服务没有订阅、投递队列和送达记录；旧入口中的 webhook 不参与新服务。后续要以 pg-boss 承载至少一次投递，事件和投递意图同事务落库，接收端按 event_id 幂等。事件生成、HTTP 送达、业务处理成功必须分别记录。

provider 同步位置、列表分页 cursor 和事件消费 cursor 是三种位置，不能混用。当前也不承诺完整邮箱镜像：旧日期邮件后来移入、远端删除和全量对账还需补充。

### 聘钉提供的三个接入契约

| 契约 | 对接方向和要求 |
| --- | --- |
| 用户身份与项目权限 | 聘钉后端调用 `PUT /admin/principals`、`POST /admin/delegations`，授予短期 human 或 agent 委托；每次业务请求和后台执行重新检查权限。原始管理 token 不提供给浏览器或 Agent |
| AI 与积分 | 邮件服务调用 `POST {MAIL_HOST_GATEWAY_URL}/match`，携带 HMAC 签名和稳定计费幂等键；聘钉原子处理权限、余额、扣点及结果回执。当前 AI 输入只是元数据和 snippet，不是完整简历评分 |
| 选中简历交付 | 邮件服务调用 `POST {MAIL_HOST_GATEWAY_URL}/import`，使用 `selection:{selection_id}` 幂等键，提交已确认的正文或附件；聘钉可靠落库后返回 import_id，后续画像评分由聘钉继续处理 |

后两个网关仅完成模拟契约测试，尚未接入真实积分和人才库。详细请求字段、签名和响应见 [接入契约](mail-intake.md#ai-与积分网关)。

## 四 适配范围和交付状态

| 范围 | 当前结论 |
| --- | --- |
| QQ 与通用 IMAP | 复用 IMAP 适配器；QQ 真实连接、列表、正文和自动发现已测。其他企业邮箱仍需逐服务商验收 |
| Gmail | API 适配器和 OAuth 接入流程已实现、模拟测试通过；真实 OAuth app 尚未配置 |
| Microsoft 365 与 Outlook | Graph 适配器及 OAuth 已实现、模拟测试通过；真实授权和收信未验收 |
| Exchange 自建部署 | 不能因支持 Graph 就声称支持所有 Exchange。可用 IMAP 的部署需实测；EWS 未实现 |
| POP3 和 SMTP | 新独立服务不提供 POP3 接入；SMTP 是发送协议，不用于本轮收信。测试发信不等于新增了生产发信接口 |
| HTTP 服务 | API、worker、PG 在本地 Compose 部署过；未发布生产 |
| SaaS | 聘钉邮箱设置、项目邮件列表及确认页面尚未接入 |
| MCP | 独立 stdio MCP 复用 HTTP 权限，实际客户端自动化通过；未挂载聘钉现有 FastMCP 或线上 Agent |

源码导航：[业务服务](../src/mail/service.ts)、[HTTP 路由](../src/mail/api.ts)、[Worker](../src/mail/worker.ts)、[协议适配封装](../src/mail/provider.ts)、[MCP](../src/mail/mcp.ts)、[网关](../src/mail/gateway.ts)。

独立 MCP 已提供邮箱连接链接、绑定、拉取、任务控制、列表和正文、匹配重跑、选择草稿及交付查询。事件补读、原始 IMAP 凭证提交、附件二进制下载尚未封装成独立 MCP 工具。人工确认由 human 身份后端约束，不交给 Agent 代批准。

## 获取代码和运行服务

```sh
git clone --branch codex/mail-sync-foundation https://github.com/iamliguangming/email-engine.git
cd email-engine
# 首次部署复制模板并填写自己的密钥；已有部署保留原配置
cp .env.mail.example .env.mail
docker compose --env-file .env.mail -f compose.mail.yml up -d --build
docker compose --env-file .env.mail -f compose.mail.yml ps
curl --fail http://127.0.0.1:8095/health
```

以上为交接后使用的命令，本次整理未执行部署或重新测试。首次启动前须完成 `.env.mail` 中三项随机密钥配置，模板不能直接当作生产凭证。运行组件为 api、worker、postgres；API 默认只绑定本机 8095，`/health` 检查服务，`/openapi.json` 提供运行时接口规范。

配置参考：[环境变量模板](../.env.mail.example)、[Compose](../compose.mail.yml)、[容器构建](../Dockerfile.mail)。`.env.mail`、邮箱授权码、访问令牌和数据库文件不进入 Git。保留已有 `MAIL_SECRET` 与数据库卷，避免已保存邮箱凭证无法解密；不要用清空数据库的方式修复连接问题。

手工启动使用 `npm run start:mail`，MCP 使用 `npm run mcp:mail`。`npm start` 和 `npm run mcp` 是上游旧入口，其 SQLite、SSE、webhook 和收发信能力不能套用到新服务。

测试时代理 DNS 将 `imap.qq.com` 解析为 `198.18.*`，被服务内网地址保护拒绝。验收临时使用经公开 DNS 核实、TLS 证书验证通过的公网解析，未关闭安全校验。这个临时环境补丁不属于仓库或生产配置；新环境需让容器得到可达的真实公网解析，不要照抄测试时的固定 IP。

## 五 为什么这样测试

自动化可以验证队列、权限和业务幂等，但受控协议响应不能证明真实邮箱已经可用。因此我们先尝试 Gmail，发现独立服务缺少自己的 OAuth 应用配置；经用户选择后转用 QQ IMAP，通过客户端授权码验证真实连接。先按区间拉取历史邮件，再从另一个邮箱发送唯一标记邮件，观察后台自然调度是否能自动发现，避免用手工拉取掩盖增量链路问题。

验收重点是三层：邮件是否收到并可读、发现事件是否持久化且可补读、事件是否真正投递到业务消费方。本轮前两层通过，第三层暴露 webhook 尚未实现。真实附件、真实 AI 扣点和人才入库没有被这次纯收信测试覆盖。

### 自动化结果

2026-10-12 执行 `MAIL_TEST_DATABASE_URL=隔离测试实例 npm test`：**39 项通过，0 失败，0 跳过**。原始输出：[TAP](mail-intake-tests.tap)。

覆盖范围包括队列恢复、事务一致性、分页和时间范围、失败续拉、取消、匹配异步化、事件去重、OAuth state 和邮箱校验、过期队列任务终态、项目与组织权限拒绝、撤权、人工确认限制，以及实际 MCP 工具发现和调用。具体说明见 [验收记录](mail-intake-validation.md)。

PostgreSQL、pg-boss 和 MCP 客户端为真实组件；自动化中的邮箱协议、AI 计费和项目入库边界使用受控或模拟实现。模拟网关幂等断言不等于真实积分账本和人才库已经验收。

重新运行前准备专用测试 PostgreSQL，按测试实现授予创建和删除测试数据库所需权限，设置 `MAIL_TEST_DATABASE_URL` 后执行 `npm test`。未配置数据库时，集成测试可能跳过，不能只看进程退出成功。测试数据库不要使用当前收信数据实例或生产实例。

## 六 真实邮箱验收

使用经所有者授权的 QQ 测试邮箱（公开材料已脱敏），协议 `imap.qq.com:993`，TLS 开启。以下是真实服务 HTTP 调用和后台任务结果，不是通过 Codex 邮箱工具代替收信。

### 历史区间拉取

| 项目 | 结果 |
| --- | --- |
| 接收时间区间 | 2026-10-05 16:20:25 至 2026-10-12 16:20:25，左闭右开 |
| 文件夹 | INBOX |
| 拉取结果 | 13 封，任务 `succeeded`，提交至完成约 5 秒 |
| 列表分页 | 每页 5 条，共 3 页；13 个唯一 ID，无遗漏或重复 |
| 正文抽查 | 3 封成功，分别 597、989、7546 字符，未截断 |
| 附件 | 抽查 3 封均无附件；真实附件下载尚未验证 |
| 幂等 | 同请求体、同幂等键返回同一任务 ID |
| 业务副作用 | 13 封均为手动待挑选，未选择入库、未开启 AI |

证据：[QQ 拉取结果](testing/2026-10-12/qq-pull-result.json)。

### 真实发信和持续发现

用户明确授权后，从所有者的 Gmail 通过 Codex Gmail 连接发送一封测试邮件到 QQ。**发送使用 Gmail 连接，接收和发现使用独立邮件服务。**

- 主题：`[聘钉邮件服务测试] PINTALENT-EVENT-3788b1e8fabf`。
- 16:24:48 QQ 收件；16:25:30.464 服务发现并持久化，约 42 秒。
- 后台自然调度生成 `origin=live` 的拉取任务；没有用手工补拉代替自动发现。
- 生成 `mail.discovered`，sequence `16`；生成 `import.completed`，sequence `17`。
- 读取正文确认唯一标记匹配，事件中的 message_id 对应同一邮件。
- 下一轮在 16:26:29.651 完成，只有新的 `import.completed`，sequence `18`；该邮件的 `mail.discovered` 仍只有一条。
- 游标补读通过；这证明持久化事件可消费，不证明 webhook 已送达。

`import.completed.payload.indexed=1` 表示该次任务关联的邮件数量；下一轮重扫同一邮件也可为 1，**不能将其当作新增邮件数或重复入库数**。判断新增发现应结合 `mail.discovered` 和稳定 message_id。

证据：[新邮件事件结果](testing/2026-10-12/qq-event-result.json)。42 秒是这一次测试的观测值，不是延迟 SLA。

## 七 测试资源和结束状态

| 资源 | 标识 |
| --- | --- |
| 本地测试 tenant / user | `local-mail-test` / `qq-mail-owner` |
| 测试 project | `qq-retrieval-test` |
| mailbox_id | `7441a71a-0372-4b19-9ff2-ce251fe7ee6c` |
| binding_id | `5fa81e98-43b5-47e8-94b3-61e0f4df7900` |
| 历史拉取 operation_id | `645e901a-dbfe-4e42-a61d-3032e8d53261` |
| 首次自动发现 operation_id | `99031884-8840-426f-b0c2-a7033941c7f1` |
| 第二轮同步 operation_id | `bdeb7c86-0edc-4728-9bbf-f5029f30b821` |

这些身份和项目仅用于独立服务本地测试，不代表聘钉生产身份或项目。

测试结束时保留邮箱连接、项目绑定和已拉取数据；将 `continuous` 恢复为 `false`，没有打开 AI，也没有执行简历选择确认。测试使用的短期令牌已撤销或到期，后续需重新签发委托。QQ 中的测试邮件保留。临时调试脚本不作为交付入口；公开仓库中的证据文件才是交接依据，不要把测试身份配置复制到生产。

## 八 接手后的操作顺序

1. 从上文 GitHub 开发分支检出代码，记录当前提交 SHA，再阅读本文件、服务说明和 OpenAPI；默认分支不代表本轮实现。
2. 在需要恢复测试时检查容器健康与 DNS；保留现有密钥和数据卷。
3. 通过管理接口同步受信身份，再签发短期用户委托。业务 API 和 MCP 不接受管理 token 代替用户权限；不要从调用参数直接信任 tenant、user 或角色。
4. 用 `GET /v1/mailboxes`、`GET /v1/bindings` 获取已有资源和当前 version。修改绑定必须提交当前 version。
5. 区间拉取使用 `POST /v1/bindings/{id}/imports` 和稳定 `Idempotency-Key`；用返回的任务 ID 判断最终结果，不能把 202 当作已完成。适度轮询任务，不让 Agent 高频查询。
6. 实时发现测试先记录 `/v1/events` 游标，再开启持续同步、发送唯一主题邮件，等待后台调度。将接收时间、任务完成、事件和正文关联起来核验，再观察下一轮去重。
7. 结束后恢复原同步设置、撤销委托；不自动确认人才入库。进一步发信或运行同步按后续明确测试安排执行。

MCP 使用 `MAIL_URL` 和 `MAIL_DELEGATED_TOKEN` 启动 `npm run mcp:mail`。现有工具包括邮箱和绑定列表、OAuth 连接、绑定更新、拉取和任务控制、邮件列表和正文读取、匹配重跑、选择草稿和交付状态查询。事件补读、原始 IMAP 凭证接入和附件二进制下载目前不是独立 MCP 工具；人工确认刻意保留在后端 human 身份检查下，Agent 只能准备草稿。

## 九 后续验收重点

| 优先项 | 当前缺口 | 完成标准 |
| --- | --- | --- |
| 新邮件事件 webhook | 新服务没有订阅管理、投递队列和送达记录；旧 `src/sync.ts` webhook 不参与新链路 | 事件与投递意图同事务持久化；pg-boss 重试；稳定 event_id、签名、幂等消费；失败可见和可重放；实际接收端有证据 |
| Webhook 故障恢复 | 尚无真实投递链路可测 | 接收端 500、超时、429、重启及回包丢失场景可恢复；重复投递不重复产生业务副作用 |
| 附件 | 真实样本只有无附件正文 | PDF、Word、多附件、中文文件名及大小限制，下载内容哈希一致 |
| Gmail 和 Graph | 自动化使用受控协议边界，无真实授权验收 | 正常授权、刷新、撤权、失效后重连、真实区间读取 |
| 持续运行 | 仅验证两轮真实自动同步 | 断网、进程重启、积压、限流、授权失效、长时间水位推进及恢复 |
| 聘钉接入 | 缺页面、真实用户委托、FastMCP 挂载、计费和人才库网关 | SaaS 与 MCP 同权限同数据；允许和拒绝路径覆盖跨组织、项目只读、无访问权、撤权与版本冲突；扣点和入库幂等 |

webhook 建议是后续工作，不是已实现能力。消费者应以 event_id 幂等，成功持久化后才确认；普通 HTTP 投递只能做到至少一次配合业务去重，不能宣称天然恰好一次。`mail.discovered` 也可能在匹配版本或邮件内容变化后再次产生，应按事件和业务版本语义处理，而不是只靠主题去重。

## 十 交接资料

- [服务接口和行为](mail-intake.md)
- [OpenAPI](mail-api.openapi.json)
- [自动化和容器验收记录](mail-intake-validation.md)
- [原始测试输出](mail-intake-tests.tap)
- [真实 QQ 拉取证据](testing/2026-10-12/qq-pull-result.json)
- [真实新邮件发现与去重证据](testing/2026-10-12/qq-event-result.json)

本次交接更新包含独立服务实现和文档的版本化交付；没有重新发信、同步或运行测试，也未部署生产。自动化和实邮结果均来自 2026-10-12，不能视为每次文档更新后重新验收。

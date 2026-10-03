# 裁决清单（勾选后才开工）

用法：在「裁决」列写 **做 / 不做 / 以后**。没勾的当不做。

复用方式只有三种：

- **协议表**：抄端点、头、host（这是「不要自己发明协议」）。
- **算法移植**：按 MIT 把 Go 逻辑写成 TypeScript，留版权行。不是 `import`。
- **二进制 sidecar**：进程外跑别人的网关。和 Codex catalog/OAuth store 双轨，默认否。

Go 包、Python 成长脚本、`workbuddy2api` 的 Redis/Web 面板：**接不进** ocx。

---

## 0. 架构先拍（改这些会翻整张表）

| ID | 题目 | 建议 | 裁决 |
|---|---|---|---|
| A1 | 一个 `workbuddy` provider，realm 挂在账号上；不要 `workbuddy-global` 第二套 | **做**。否则 catalog、auth.json、failover 全裂。混域请求用账号 realm 选 host；若要强制某域，再用模型前缀或账号钉死。 | 做 |
| A2 | 专用 `workbuddy` 池模块，不膨胀 `generic-account-failover.ts` | **做**。generic 文件自己禁止 affinity / 加权 / lease。对标 `anthropic-routing.ts`。 | 做 |
| A3 | 把 `workbuddy2api` 当 sidecar，ocx 只转 Responses | **不做**。双份凭证、双份冷却、catalog 仍要自己做；国际站协议还是得在 ocx 里写对。 |  |
| A4 | 成长任务 / 国际站调度走 optional hook，CN-only 用户零 import | **做**。沿用现有 checkin 的 `optional-shutdown-hooks`。 | 做 |

---

## 1. 国际站协议（没有这块，双域池是空话）

来源：`workbuddy2api` `cmd/login/main.go` + `internal/upstream/{client,headers}.go`；交叉：`CangShui` `main.go` profileINTL。

| ID | 功能 | 现状 | 复用 | 建议 | 裁决 |
|---|---|---|---|---|---|
| P1 | Global 登录：`https://www.workbuddy.ai/v2/plugin/auth/state` + token 轮询 + account | 只有 `www.codebuddy.cn`，`platform=ide` | 协议表。**platform 三家不一致**：我们 `ide` / wb2api `CLI` / CangShui 国际站 `workbuddy-ai`。国际站建议先跟 CangShui 的 `workbuddy-ai`（浏览器邮箱/SSO），CN 保持 `ide`。 | **做** | 做 |
| P2 | 凭证增加 `realm`（cn/global），domain 含 `workbuddy.ai` 则 global；逃生门 `global.enabled=false` 只路由 CN | `CodebuddyOAuthMetadata` 无 realm；checkin 用 domain 排除国际站 | 协议表，抄 `auth.go` `Realm()` / `isGlobalDomain` / `SetGlobalEnabled` | **做** | 做 |
| P3 | 出站 host 按账号切：CN `copilot.tencent.com`；Global `www.workbuddy.ai`。chat 路径两边都是 `/v2/chat/completions`（不要 `/console`，WAF 403） | adapter **拒绝**非 canonical CN URL | 协议表，`client.go` `chatBase` | **做** | 做 |
| P4 | Global 头：Origin/Referer=`www.workbuddy.ai`；`Accept-Language: en-US`；`X-Domain: www.workbuddy.ai`；`X-No-Enterprise-Id: 1`；UA 平台段 `WorkBuddy AI`（错成 `WorkBuddy` 可能 11140） | 固定 `CodeBuddyIDE` / `SaaS` / 无 Origin | 协议表，`headers.go` | **做** | 做 |
| P5 | 刷新打对应域 `.../v2/plugin/auth/token/refresh`，带 `X-Auth-Refresh-Source: plugin` | 只打 codebuddy.cn | 协议表 | **做** | 做 |
| P6 | 模型发现打对应域 `/v2/enterprises/personal/models`（Global 实测不要 `/console`） | 相对 CN `baseUrl` | 协议表 | **做** | 做 |
| P7 | 6004 英文重置：`will reset at YYYY-MM-DD HH:MM:SS UTC+8`（以及 `, alternatively` 尾巴） | 只认中文「将在 … UTC+8」 | 算法移植，优先 `buddy-proxy` `internal/billing/quota.go`（已覆盖真实英文 6004） | **做** | 做 |
| P8 | Global 首条必须是 system，否则 11128；混池会表现为「一半请求随机失败」 | 无此归一 | 协议表，`CangShui` `ensureLeadingSystemMessage`；wb2api 也有 `ensureConsoleSystem` | **做** | 做 |
| P9 | Global 一次性 trial：`POST {billingBase}/billing/ide/trial`，14051=已领过当成功。国际站**没有**日常签到 | 无 | 协议表，`trial.go`。这是国际站几乎唯一的官方积分动作 | **做** | 做 |
| P10 | Global billing 路径试 `/billing/meter/*` 再回落 `/v2/billing/meter/*` | CN 只用 `/v2/billing/meter/...` | 协议表，`client.go` 注释 | **建议** | 做 |
| P11 | `ocx account login workbuddy --realm global`（或 dashboard 选国际站） | 登录无 realm | 接到现有 OAuth controller | **做** | 做 |

---

## 2. 双域同一池（调度，不是协议）

来源：`workbuddy2api` `internal/pool/*` + `internal/session/session.go`。  
ocx 已有：≥2 号才换、6004 模型级冷却（内存）、14018 整号、单请求最多 3 次、6004 **不改**你手动当前号。

| ID | 功能 | 现状 | 复用 | 建议 | 裁决 |
|---|---|---|---|---|---|
| Q1 | 选号先按请求 realm 过滤，CN 号不接 Global 请求、反之亦然 | 无 realm | 算法移植，`realm.go` `PickExcludingForRealm` | **做**（A1 的配套） | 做 |
| Q2 | 积分加权：credits 比例×10 + 快过期占比×8 + 闲置补偿；Top-5 再抽 | generic 只有 headroom 三档 + round-robin/quota/fill-first | 算法移植，`pick.go` `weightOf` | **建议**。没有积分快照时退化为现有 headroom | 做 |
| Q3 | 成本分层：账号×模型 记 `usage.credit` → 免费 / 未知 / 收费；只在最便宜层抽；30min 搭车探索未知号 | 无 | 算法移植，`pick.go` costTier | **建议**。要打真实请求才能学习；探索会把用户请求改道 | 做 |
| Q4 | 快过期积分先花（`creditsExpiring`，默认 7 天窗） | 无 | 依赖 Q2 + 余额接口能返回到期批次 | **建议**（绑 Q2） | 做 |
| Q5 | 会话粘性：conversationId / prompt_cache_key / 首条 user 文本 hash；TTL 30min；6004 时粘性失效换号；成功后绑到实际成功号 | 无。generic 明确不做 affinity | 算法移植，`session.go`。Codex Responses 要从 metadata / prompt_cache_key 取键 | **建议**。保上游 prompt cache，对 hy3 特别有用 | 做 |
| Q6 | 熔断：连续失败阈值（默认 3）后指数退避，封顶 6h | 只有 429/402 冷却 | 算法移植，`cooldown.go` + config `breaker_*` | **建议** | 做 |
| Q7 | 在途租约：单号并发上限（CN 默认 3，Global 默认 2，防 WAF） | 无 | 算法移植，`inFlightFull` | **建议** | 做 |
| Q8 | 防惊群：100ms 内刚选中的号跳过 | 无 | 算法移植，`minPickGap` | **建议**（绑 Q2） | 做 |
| Q9 | 状态落盘：冷却/熔断/积分/成本账本/usedSeq → `~/.opencodex/workbuddy-pool.json`（原子写） | 冷却进程内存，重启全忘 | 算法移植，`persist.go` 的本地一半。Redis 镜像 **不做** | **做**（没有它，重启后双域池等于没冷却） | 做 |
| Q10 | 402 余额耗尽硬冷却到次日 04:00 CST | 14018 用解析到的 reset 或 24h 封顶 | 可对齐 wb2api `nextDay4AM` | **可选** | |
| Q11 | 会话粘性 Redis 镜像 | ocx 单进程 | 不接 | **不做** | |
| Q12 | 成本探索「零新增上游请求、只改道真实用户请求」 | 无 | 与 Q3 绑定 | 跟 Q3 | |

---

## 3. 成长任务（和推理热路径分开）

来源：`workbuddy2api` `internal/scheduler/*` + `internal/upstream/{travel,growth_*,report,trial}.go`。  
现有：CN 每日 09:10 签到；**Global 账号跳过签到**（两边一致：国际站没有日常签到）。

### 3a 国际站积分

| ID | 功能 | 域 | 建议 | 裁决 |
|---|---|---|---|---|
| G1 | Trial 加油包（P9） | **仅 Global** | **做**。登录成功后领一次，14051 当已领 | 做 |
| G2 | 国际站日常签到 | Global | **不做**。上游无此能力，wb2api/CangShui 都跳过 | |
| G3 | Global 的 `/activity/growth/*` 同构（连登/抽奖） | 两边都有路径 | **可选**。wb2api 注释写 global 同构；travel/checkin 仍跳过 global | 做 |

### 3b 中国站成长（wb2api 默认全开；和「国际站」目标正交）

| ID | 功能 | 时点 (CST) | 端点（协议表可抄） | 建议 | 裁决 |
|---|---|---|---|---|---|
| G4 | 日常签到（已有） | 09:10；wb2api 是 09+21 | `/v2/billing/meter/daily-checkin` + status | **保持**。若要对齐社区再加 21 点 | 做 |
| G5 | 签到加一档 21:00 | 21 | 同 G4 | **可选** | 做 |
| G6 | 活跃地图 / 对话上报 | 10 | `POST /v2/report`（默认连发 5 条刷 chat_5） | **可选**。会伪造活跃，风控面比签到大 | 做 |
| G7 | 热力图 + 补签卡 | 随 G6 | `GET /activity/growth/heatmap`，`POST /activity/growth/makeup-cards/use` | **可选**（绑 G6） | 做 |
| G8 | 连登兑换 + 抽奖 | 随 G6 | `GET/POST /activity/growth/streak|redeem|lottery/*` | **可选** | 做 |
| G9 | 新手礼包 / 活动补偿 | 随 G6 | `POST /billing/meter/claim-gift`，`claim-compensation` | **可选** | 做 |
| G10 | 猫猫旅行：info / 协议 / 领养 / 派出 / 领奖 | 09+21 | `/activity/growth/buddy/{info,agreement,first,travel/*}` | **可选**。纯积分运营，与 Codex 无关 | 做 |
| G11 | 开学季任务 | 12 | **Python 脚本** `scripts/school_open_day_2026.py` 由 Go 拉起 | **不做**。不要把 Python 子进程和季节脚本带进 ocx；活动会下线 | |
| G12 | 夜猫子 black_cat | 01（23:00–08:00 窗） | 同上，走 Python | **不做**（同 G11） | |
| G13 | Token 保活 22:00 全号 refresh | 22 | 已有 lazy-only refresh | **可选**。国际站 token 也走现有 refresh；不必单独抄调度，除非你要主动保活 | |

---

## 4. 风控 / 兼容（国际站更容易踩）

| ID | 功能 | 来源 | 建议 | 裁决 |
|---|---|---|---|---|
| R1 | 11128：首条 system（P8 已列） | CangShui | **做** | 做 |
| R2 | 11128 模板黑名单：改掉 Claude Code / Codex 指纹句（精确匹配） | cliproxy `sanitizeBlockedTemplates`；wb2api `sanitize.go` | **建议**。Claude 走 ocx `/v1/messages` 再进 WorkBuddy 时会打中 | 做 |
| R3 | 会话头族：`X-Conversation-ID` / `X-Conversation-Request-ID` / B3。同轮 tool/重试/换号复用 | wb2api `headers.go` injectConversationHeaders | **建议**（和 Q5 一起才有 cache 收益） | 做 |
| R4 | `X-Device-Token`（桌面 Turing SDK） | wb2api；`xiaofan6ya/workbuddy2api` 读桌面 `.info` | **可选**。ocx 现在不偷桌面登录态；无 token 则不发该头 | 做 |
| R5 | 稳定 `X-Machine-ID` / `X-Session-ID`（uid 派生，跨重启不变） | wb2api `deriveAccountStableID` | **建议**。比设备 token 便宜，防多号无设备指纹被关联 | 做 |
| R6 | 出站指纹清洗（git status 进上下文触发 11128 等） | wb2api `features.sanitize_blacklist_fingerprints` | **可选** | 做 |
| R7 | 强制 stream + max_tokens 封顶 | 已有 | 保持 | — |
| R8 | 用量归属头：默认伪装 WorkBuddy 桌面（`X-IDE-Name=WorkBuddy`）还是继续 `SaaS`/`CodeBuddyIDE` | wb2api 默认桌面；我们 CN 用 IDE/SaaS | **建议**：CN 维持现状；Global 用 WorkBuddy AI 桌面头（P4） | CN 维持现状；Global 用 WorkBuddy AI 桌面头（P4） |

---

## 5. 明确不接

| 东西 | 原因 |
|---|---|
| `workbuddy2api` Go 源码进 `src/` | 运行时是 Bun |
| 社区 panel / manager / Android / Tauri fork | 另一产品 |
| Upstash Redis | 单机 ocx 用文件即可 |
| 把 ocx 变成 OpenAI 中转站主业 | 目标仍是 Codex 内嵌 |
| 官方 npm `ocx update` 带上这层 | overlay 策略不变 |
| 开学季/夜猫 Python | 季节脚本 + 另一运行时 |

---

## 6. 建议施工切块（你勾完再排）

**块 0 — 国际站能登录、能打通（P1–P9, P11, R1, R8）**  
没有这块，后面的池都是 CN 加强。

**块 1 — 双域同一池最小集（A1, A2, A4, Q1, Q9, P7）**  
realm 过滤 + 冷却落盘 + 英文 6004。行为接近「现在的 CN 多号，加上国际站账号能进同一 store」。

**块 2 — 池变聪明（Q2–Q8, R3, R5）**  
加权、分层、粘性、熔断、租约、防惊群。这是 wb2api 的产品差异，不是通站前提。

**块 3 — 积分运营（G1 必做于国际站；G5–G10 全是 CN 农场，逐项勾）**

---

## 7. 你需要拍的未知项（会影响实现形状）

1. **混域时 Codex 选择器长什么样？** 同一个 `workbuddy/hy3` 由池在 CN/Global 间挑，还是要 `workbuddy/global:hy3` 这种前缀？（wb2api 用 `cn:`/`global:` 前缀给 OpenAI 客户端。）

   选择器仍是 workbuddy/hy3、workbuddy/auto（和现在一样）
   • 域写在账号上：你点开哪个号，请求就打哪个 host
   • 换号只在同一 realm 里换（CN 6004 不会跳到 Global 号上）
   • 凭证还是同一个 workbuddy 槽，这就是「双域同一池」：一个 store、两套 host，一次请求不跨域

2. **Global 登录 platform 用 `workbuddy-ai` 还是 `CLI`？** 建议先 `workbuddy-ai`，失败再试 `CLI`。不要用现在的 `ide` 打国际站。

   Global 的 auth/state 先带 platform=workbuddy-ai。拿不到 state/authUrl 再试 CLI。CN 继续 ide，两条登录链不要合成一个 platform。

3. **块 2 是否要进第一期？** 只开国际站账号、沿用现有 generic failover，也能「双域同 store」；加权/粘性是增强。

4. **CN 成长任务要不要一起做？** 和「国际站」目标无关。建议第一期只 G1（Global trial）+ 现有签到。

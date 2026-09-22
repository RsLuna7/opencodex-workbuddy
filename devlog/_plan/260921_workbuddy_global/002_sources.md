# 源码对照（2026-09-21 抓取）

本地只读克隆（gitignored）：`.tmp/wb-research/{workbuddy2api,workbuddy-gateway,buddy-proxy}`

## 仓库

| 仓库 | ★ | 许可 | 语言 | 角色 |
|---|---:|---|---|---|
| [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | 1306 | MIT (c) 2026 Sliverkiss | Go | 双域协议 + 号池 + 粘性 + 成长任务的事实标准 |
| [CangShui/workbuddy-gateway](https://github.com/CangShui/workbuddy-gateway) | 151 | 仓库免责声明 | Go | 国际站 login `platform=workbuddy-ai`；国际站强制首条 system（11128） |
| [wnddd839/buddy-proxy](https://github.com/wnddd839/buddy-proxy) | 37 | BSD-3-Clause | Go | 产品×站点正交；英文 6004 `will reset at` 解析 |
| [lovingfish/workbuddy-cliproxy](https://github.com/lovingfish/workbuddy-cliproxy) | 177 | MIT | Go | CPA 插件；Claude Code 模板黑名单改写 |
| 本仓库 overlay | 0 | 随 ocx | TypeScript | Codex 内嵌 CN adapter |

## workbuddy2api 关键文件

| 主题 | 路径 |
|---|---|
| 双域登录 | `cmd/login/main.go`（`--realm=global`，host=`www.workbuddy.ai`，`platform=CLI`） |
| realm 归一 | `internal/auth/auth.go`（domain 后缀 `.workbuddy.ai` → global；`global.enabled=false` 逃生门） |
| 出站 host | `internal/upstream/client.go` `chatBase` / `billingBase` |
| Global 头/UA | `internal/upstream/headers.go` |
| 选号 | `internal/pool/pick.go` |
| 分域过滤 | `internal/pool/realm.go` |
| 6004/402 冷却 | `internal/pool/cooldown.go` |
| 粘性 | `internal/session/session.go` |
| 落盘 | `internal/pool/persist.go` |
| 排程 | `internal/config/schedule.go` + `internal/scheduler/` |
| 猫猫 | `internal/upstream/travel.go` |
| 活跃/补签 | `internal/upstream/growth_bonus.go` `growth_reward.go` `report.go` |
| Global trial | `internal/upstream/trial.go` `POST /billing/ide/trial` |
| 默认配置 | `config.example.json` |

## 本仓库现状（CN only）

| 主题 | 路径 |
|---|---|
| 登录/refresh | `src/oauth/codebuddy.ts`（`CODEBUDDY_AUTH_ORIGIN=www.codebuddy.cn`，`platform=ide`） |
| Adapter | `src/adapters/codebuddy.ts`（只认 `copilot.tencent.com/v2`，头 `CodeBuddyIDE`/`SaaS`） |
| 6004/14018 → 402 | 同上 + `src/server/responses/request-transport.ts` |
| 通用换号 | `src/oauth/generic-account-failover.ts`（内存冷却，无粘性） |
| 签到 | `src/oauth/codebuddy-checkin.ts`（跳过 `workbuddy.ai`） |
| 账号元数据 | `src/types` `CodebuddyOAuthMetadata`：仅 `uid/enterpriseId/domain`，无 `realm` |

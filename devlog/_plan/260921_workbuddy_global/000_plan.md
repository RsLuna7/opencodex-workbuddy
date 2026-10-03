# WorkBuddy CN + Global 双域同一池

状态：裁决已冻结，开工中。见 `003_implementation.md`。

日期：2026-09-21  
对照基线：本仓库现有 `workbuddy` provider（仅中国站）+ 公开成熟网关源码（已 shallow clone 到 gitignored `.tmp/wb-research/`）。

## 一句话

GitHub 上成熟方案几乎全是 **Go 专用网关**，不能当 npm 包接进 Bun runtime。能「直接复用」的只有：**协议表、端点、头字段、选号算法、MIT 许可下的移植**。把 `workbuddy2api` 当 sidecar 是唯一的二进制级复用，和 Codex 内嵌目标打架，默认不采用。

## 本分区文件

| 文件 | 内容 |
|---|---|
| [001_decision_list.md](./001_decision_list.md) | 给你勾选的功能清单（主交付） |
| [002_sources.md](./002_sources.md) | 仓库、文件、许可证对照 |

## 建议架构（可改，等你拍）

1. 继续一个 provider id：`workbuddy`。域写在账号上 `codebuddy.realm: "cn" | "global"`，不要拆成两个 provider（catalog / OAuth store / failover 会裂成两套）。
2. 新开 WorkBuddy 专用池模块（对标 `src/oauth/anthropic-routing.ts`），**不要**把积分加权/粘性/熔断塞进 `generic-account-failover.ts`（该文件自己写明：无 session affinity、无 quota-ranked 选号、无 probe lease）。
3. 成长任务继续走 optional hook（现有 `codebuddy-checkin.ts` 模式），不得 import 进 `router.ts` / `lifecycle.ts` / `responses/core.ts`。
4. 算法从 `Sliverkiss/workbuddy2api`（MIT）移植时在 NOTICE/CREDITS 留版权行。不 vendoring Go、不提交 `.tmp/wb-research/`。

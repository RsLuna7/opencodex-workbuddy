# STATUS

当前位置：PR https://github.com/RsLuna7/opencodex-workbuddy/pull/7。双域 + 池 + trial/成长/GUI 已在分支上。2026-09-21 真实跑通验证通过（隔离代理 `127.0.0.1:18763`，当前源码）。

## 额度 / 签到盘点（2026-09-21 15:16 CST，get-user-resource 实测）

仪表盘账户页：剩余积分 + 国内方标（已签到绿 / 未签到灰，每日任务绿 / 任务未做灰）。国际站无日常签到标。刷新额度会重拉账单。

| 号 | 域 | 剩余 | 已用 / 总量 | 今日签到 |
|---|---|---|---|---|
| 4ever | CN | 200 | 1300 / 1500 | 已签，连签 2，today_credit=100 |
| A | CN | 1941 | 759 / 2700 | 已签，连签 2，today_credit=100 |
| ppopios | Global | 350 | 0 / 350 | 国际站无日常签到（trial 已领） |
| 第二个国际站 | Global | 350 | 0 / 350 | 同上 |

国内签到双保险：代理 09:10+21:10 CST；计划任务 `WorkBuddy Daily Checkin` 每天 09:10 跑 `~/.opencodex/scripts/workbuddy-checkin.cmd`。验证：`bun run src/cli/index.ts account checkin workbuddy --status --json` 看 `today_checked_in`。

成长任务（活跃上报/领奖/猫猫旅行）在源码里，跟签到调度一起开；开学季脚本没接。4ever 只剩近两天签到包，A 还有一大包裂变积分。

## 已验证（真实过程，无失败）

- `bun x tsc --noEmit` 通过。
- WorkBuddy 相关测试 90 pass / 0 fail（realm / pool / account-pool / checkin / growth / cli-checkin / layout / skill-ocx）。
- 管理 API：`POST /api/oauth/login` CN → `www.codebuddy.cn`；Global → `www.workbuddy.ai`；cancel 200。
- 本机两个 CN 账号接入隔离代理后，`POST /v1/chat/completions` `workbuddy/hy3` HTTP 200，回复 `WB_E2E_OK`。
- `ocx account checkin workbuddy --status/--json`：两账号 `STATUS` / `ALREADY_CLAIMED`，exit 0；隔离目录写出 `workbuddy-pool.json`。
- 仪表盘「添加提供方 → 账户」点「添加国际站账号」：登录 URL `https://www.workbuddy.ai/login?platform=workbuddy-ai`，文案 international；取消后 toast「WorkBuddy 登录已取消」。

## 未覆盖

- 工作区「提供方 → WorkBuddy → 账户」页只有「添加账户」（CN）；国际站按钮在「添加提供方」目录里。
- 已登录的国际站号要等下一次 token 刷新（或再登录一次）才会把 `realm`/`platform` 写进 `auth.json`；路由现在仍靠 domain。

## 收尾

- 用户代理当前源码：10100 pid 1992。
- 国际站账号已登录（id …0647dfc7，label ppopios，domain www.workbuddy.ai），且为当前 active。
- 实测 `POST /v1/chat/completions` `workbuddy/hy3` HTTP 200，回复 `WB_GLOBAL_E2E_OK`；池子对该号记了 lastSuccess。
- `ocx account checkin workbuddy`：两枚 CN `ALREADY_CLAIMED`；国际站 trial `ALREADY_CLAIMED` http 200。

下一步：要用国际站，保持 active 为该号；CN 与 Global 不会互相 failover。

## 指纹 / 防封（已按顺序落地）

1. 签到/trial/成长 UA → `WorkBuddy/5.5.4`（账单头对齐桌面）。
2. `auth.json` 会保存 `realm`/`platform`/`deviceToken`；可选 `OPENCODEX_WORKBUDDY_DEVICE_TOKEN_FILE`（只读，不写回）。
3. WorkBuddy 出站钉 HTTP/1.1，传输失败后下一跳 `keepalive: false`。
4. WAF 403（无业务信封）软冷却该号；60s 内两个 UID 则停止换号。

`tsc` + 83 个相关测试通过；`structure:check` / `privacy:scan` 通过。10100 需重启才吃到这份代码。

# 本分支：OpenCodex + WorkBuddy + ZCode Plan

ZCode Plan 提供方 id：`zai-plan`（仪表盘 label「ZCode Plan」）。不要占用 `ocx zcode`（那是把 ZCode 客户端接到 ocx）。

上游：`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`  
登录：`ocx login zai-plan`（默认导入本机 `~/.zcode/v2` 桌面 JWT）。Codex 选 `zai-plan/GLM-5.3-Flash`。

首次对话会弹独立 Chrome 过阿里云无痕验证（headless 会 F001）。验证码和 `/messages` 必须同一 Chrome 出站。

运营页：`http://127.0.0.1:10100/zai-plan`  
自动领取 / 每日日活默认关。

## 3012 unusual activity

不是封号。两层扳机：

1. 会话风控：连打、验证码出口和对话出口不一致 → HTTP 405 / `code:3012`。停一阵会退回 3007（要码）。
2. 请求体/头不像官方 Electron：模型请求 **不要** `X-Device-Mid`；`metadata.user_id` 必须是 `{"device_id","account_uuid":"","session_id"}`；system 要带 Desktop Context；`You are powered by the model named X` 是 Environment 最后一行。

本机对照官方 `zcode.cjs` 3.11.2 后，同 Chrome 过码已打到 `/messages` 200。再出现 3012 时停止连打，隔数小时只允许一次无码探测（3007=窗口开了）。

计费看 `.../zcode-plan/billing/balance`，不是 `billing/current`。

## 别的电脑怎么装

同 [WORKBUDDY.md](./WORKBUDDY.md)：clone `workbuddy` 分支，`bun install`，`bun run build:gui`，`bun run src/cli/index.ts start`。不要 `npm install -g @bitkyc08/opencodex`。

账号每台自己登。不要把 Plan JWT、`~/.opencodex` token、`~/.zcode` 凭证写进 git 或对话。

## 许可

对照公开协议重写，MIT。不要拷 AGPL 的 zcode2api Python / `solver.js`。

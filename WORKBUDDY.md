# 本分支：OpenCodex + WorkBuddy（私货）

基于官方 **v2.48.0**。额外功能：腾讯 WorkBuddy / CodeBuddy 中国站作为 OAuth 提供方，登录后实时拉模型目录。

上游 remote 名是 `upstream`（`lidge-jun/opencodex`）。你的 GitHub 是 `origin`。

## 别的电脑怎么装

不要 `npm install -g @bitkyc08/opencodex`（那是官方包，没有 WorkBuddy）。

```powershell
git clone -b workbuddy https://github.com/RsLuna7/opencodex-workbuddy.git
cd opencodex-workbuddy
bun install
bun run build:gui
bun run src/cli/index.ts start
```

另开终端：`bun run src/cli/index.ts init`（如需把 Codex 指到本机代理）。仪表盘登录 **WorkBuddy**。账号每台电脑自己登，不要复制 `~/.opencodex` 里的 token 到 git。

Windows 服务/托盘官方 npm 才自动装；从源码跑就是前台 `start`。

## merge 官方 main 之后，私货还在吗？

**还在。** git merge 是把官方新提交叠进来，不会自动扔掉 `workbuddy` 分支上已有的提交。

但要注意：

- 官方改了你也改过的同一处文件（例如 `src/providers/registry.ts`、`src/oauth/index.ts`），会出现 **冲突**。解决时要留下 WorkBuddy 那段，私货才还在。
- 官方大重构适配器/OAuth 时，冲突会很难，需要再对一下协议。
- 合并后在本机 `bun install`、`bun run build:gui` 再启动。
- `ocx update` 仍然是官方 npm，**不会**更新这个分支。要用私货就一直从本仓库拉 `workbuddy`。

示例：

```powershell
git fetch upstream
git merge upstream/main
# 有冲突就解决后 commit
```

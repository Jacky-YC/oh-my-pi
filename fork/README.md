# omp fork 定制与发布

这个目录把 `Jacky-YC/oh-my-pi` 变成「跟随上游 + 自动发 GitHub Release」的定制版。

## 文件

| 文件 | 作用 |
|---|---|
| `fork/apply-customizations.mjs` | 构建前打补丁：ACP 自动标题、自更新指向本 fork、原生 addon 下载指向本 fork、workspace 版本号 |
| `.github/workflows/fork-release.yml` | 每日/手动：合并上游 → 应用定制 → 构建 darwin-arm64 → 发 GitHub Release |

## 自动运行

无需手动触发：`schedule: */30 * * * *` 每 30 分钟检查一次，命中新上游版本才启动 macOS 构建。

需要立刻重跑当前版本时：GitHub → Actions → **fork-release** → Run workflow，勾 `force`。

流程：

1. `git fetch upstream main` + `git merge`（只发生在 runner 工作区，不推 main）；
2. 读上游 `packages/coding-agent/package.json` 版本，生成 `X.Y.Z-N`；
3. 应用 `fork/apply-customizations.mjs`；
4. `bun install` → `bun --cwd=packages/natives run build` → `RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries`；
5. 创建 tag `vX.Y.Z-N` 和 GitHub Release（二进制 + `.sha256`），不发 npm/brew。

## 自更新

`fetchBuild()` 在编译时烘焙 `FORK_GITHUB_REPO = "Jacky-YC/oh-my-pi"`，所以：

- `omp update` 与启动检查读取本 fork 的 `/releases/latest`；
- 下载资产名 `omp-darwin-arm64`，校验同目录发布的 `omp-darwin-arm64.sha256`；
- 原生 addon 缺失时的 curl 提示也指向本 fork。

Release 不要标记 prerelease，否则 `/releases/latest` 看不到。

## 定制补丁

`apply-customizations.mjs` 全部使用精确锚点，上游改动导致失配会直接失败，不会静默发布未定制版本。当前包含：

1. `packages/coding-agent/src/main.ts`：ACP 不再强制 `PI_NO_TITLE=1`，且 `autoTitle = isInteractive || mode === "acp"`（Air 通过 `session_info_update` 显示生成的标题）。
2. `packages/coding-agent/src/cli/build-service.ts`：`fetchBuild()` 优先走本 fork 的 GitHub Releases。
3. `packages/natives/native/loader-state.js`：原生 addon 回退下载 URL 指向本 fork。
4. 所有 workspace 包版本 + 根 catalog 版本统一改成 `X.Y.Z-N`。

脚本不幂等：重复运行前先 `git checkout -- .`。

## 限制

- 只构建 **darwin-arm64**。其他平台需在对应 runner 上重复 host native 构建，或按上游方式在 Linux 用 Bazel 交叉编译，再加入 `RELEASE_TARGETS` 与 release 资产。
- 没有 Developer ID 签名/公证：macOS 上 Bun 输出自带 ad-hoc 签名；浏览器下载后可能需 `xattr -d com.apple.quarantine <binary>`。
- 首次推送 main 会触发上游 `CI`（vmon 自托管 runner，本 fork 无），可能排队；`fork-release` 每次运行会尝试用 API 自动禁用它，也可以在 Actions 页面手动禁用。
- 上游 `ci.yml` 保持原样，避免 `git merge upstream/main` 冲突。
- 许可证：上游 MIT，保留 `LICENSE` 与 `THIRD-PARTY-NOTICES.txt`。

<!-- build trigger 1793956138 -->

<!-- cache probe 1793957615 -->

<!-- build 1793957968 -->

## ACP registry (IntelliJ IDEA Air)

Every release publishes `registry.json` and `omp-darwin-arm64.tar.gz`:

```
https://github.com/Jacky-YC/oh-my-pi/releases/latest/download/registry.json
```

Point Air at it (Help > Edit Custom VM Options, then restart):

```
-Dair.acp.registry.url=https://github.com/Jacky-YC/oh-my-pi/releases/latest/download/registry.json
```

Then install **Oh My Pi Agent** from the Agents page once. Sessions use `acp.registry.omp`,
get the fork's auto-generated emoji titles, and the registered icon.

Alternative self-hosted binary (no registry): `curl -fsSL .../releases/latest/download/omp-darwin-arm64`.

registry run trigger 2026-11-06T13:53:51Z

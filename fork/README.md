# omp fork kit — 定制 + 追上游 + 自动发 Release

把 `fork/` 和 `.github/workflows/fork-release.yml` 复制进你的 `Jacky-YC/oh-my-pi` fork 根目录即可。

## 它会做什么

1. **每天 03:23 UTC**（或手动 dispatch）拉取 `can1357/oh-my-pi` 的 `main`，与你的 fork 合并。
2. 读取上游 `packages/coding-agent/package.json` 的版本；如果该版本还没发过 fork release，就生成 `X.Y.Z-fork.N`。
3. 应用定制（`fork/apply-customizations.mjs`，全部带锚点断言，上游改动导致失配会直接失败）：
   - **ACP 自动标题**：去掉 `main.ts` 里 `mode === "acp"` 的 `PI_NO_TITLE` 闸门，并允许 `autoTitle = isInteractive || mode === "acp"`；Air 会通过现成的 `session_info_update` 收到 `🐘 OMPACP: …` 这样的标题。
   - **自更新指向 fork**：`build-service.ts` 的 `fetchBuild()` 在编译时烘焙 `FORK_GITHUB_REPO`，改为查询你 fork 的 GitHub Releases（`/releases/latest` 或 `/releases/tags/v<version>`），沿用原有的下载/校验/替换逻辑。
   - **原生 addon 回退下载**：`packages/natives/native/loader-state.js` 的 URL 改成你的 fork。
   - **版本号**：所有 workspace 包 + 根 `package.json` 的 `@oh-my-pi/*` catalog 一并改成 `X.Y.Z-fork.N`（否则 bun 会去 npm 解析而不是链接本地 workspace）。
4. 构建 `darwin-arm64` 二进制（host native addon + Bun 编译），生成 `.sha256`。
5. 创建 tag `vX.Y.Z-fork.N` 并发布 GitHub Release（**不发 npm / brew / build.stencil.so**）。

**不推 fork 的 main 分支**：合并只发生在 CI 工作区，避免触发上游那套依赖自托管 vmon runner 的 `CI` workflow。

## 安装步骤

```bash
git clone https://github.com/Jacky-YC/oh-my-pi.git
cd oh-my-pi
# 复制本 kit
cp -R /path/to/omp-fork-kit/fork ./fork
mkdir -p .github/workflows
cp /path/to/omp-fork-kit/.github/workflows/fork-release.yml .github/workflows/
git add fork .github/workflows/fork-release.yml
git commit -m "chore: fork release pipeline"
git push
```

然后在 GitHub 仓库：

1. **Settings → Actions → General**：允许 Actions（fork 默认是允许的）。
2. **禁用上游的 `CI` workflow**：它非 PR 事件依赖 `vmon-large/from=omp-ci` 自托管 runner，在 fork 里会永远排队。`fork-release` 每次运行会尝试用 API 自动禁用它（`continue-on-error`）；首次推送 main 时那一轮 CI 仍会启动，手动取消或等它自动禁用即可。
3. 手动跑一次 **fork-release**（`Run workflow`，可选 `force`）。

## 版本与自更新

- tag / 二进制版本：`X.Y.Z-fork.N`（semver 预发布），同一上游版本重跑时 N 递增。
- Release **不标记 prerelease**，这样 GitHub 的 `/releases/latest` 能返回它，`omp update` 才能用。
- 编译进二进制的 `FORK_GITHUB_REPO` 是 `${{ github.repository }}`（构建时写入），所以：
  - `omp update` 与启动更新检查会读取你 fork 的 latest release；
  - 下载资产名 `omp-darwin-arm64` + 同名 `.sha256`，与上游 build-service 的 `BuildAnswer` 形状一致，校验逻辑不变；
  - 原生 addon 缺失时的 `curl` 提示也指向你的 fork。

想换 fork 仓库名：改 workflow 里的 `--repo "$GITHUB_REPOSITORY"` 无需改；`FORK_GITHUB_REPO` 是构建时注入的，不会硬编码旧值。

## 本地验证（可选）

```bash
cd oh-my-pi
node fork/apply-customizations.mjs --repo Jacky-YC/oh-my-pi --version 18.17.0-fork.1
git diff --stat            # 预期 16 个文件左右的小改动
bun install
bun --cwd=packages/natives run build
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries

# 检查 ACP 标题是否生效（等首个回复后应出现 session_info_update.title）
bun packages/coding-agent/src/cli.ts acp --approval-mode yolo
```

## 限制与注意

- **只构建 darwin-arm64**。要别的平台：在对应 runner 上跑同样的 host 构建（`macos-13` 出 x64，`ubuntu` 出 linux），或在 `ubuntu-22.04` 上按上游方式用 Bazel 交叉编译 addon，然后加到 `RELEASE_TARGETS` 和 release 资产里。
- **签名/公证**：在 macOS runner 上 Bun 编译出的 arm64 二进制自带 ad-hoc 签名，可以直接运行；但没有 Developer ID 签名和公证，浏览器下载后可能带 quarantine，需要 `xattr -d com.apple.quarantine <binary>`。要正式签名/公证，请加 `codesign` + `notarytool` 步骤并配置 Apple secrets（上游的 `scripts/ci-macos-sign.sh` 只能在 Linux 上用，别直接复用）。
- **脚本不是幂等的**：`apply-customizations.mjs` 检测到已应用会直接报错，请先 `git checkout -- .` 再重跑。
- **上游锚点变化会让构建失败而不是静默出错**：`main.ts` 的 `PI_NO_TITLE` 条件、`options.autoTitle = isInteractive`、`fetchBuild(` 的文档注释、loader 的 URL 都是精确匹配。失败时按报错更新脚本里的锚点即可。
- **不要 `omp update` 到上游**：fork 二进制已烘焙 fork 仓库，正常不会；但仍建议 `omp config set startup.checkUpdate false` 如果你只想手动控制更新节奏。
- **许可证**：上游 MIT，保留 `LICENSE`、`THIRD-PARTY-NOTICES.txt`；修改版可闭源分发，但需保留版权与许可声明。
- 长期最优仍是把 ACP 标题那两行提 PR 给上游；这个 fork 流水线可以作为过渡或承载更多私有定制。

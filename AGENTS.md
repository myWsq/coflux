# AGENTS.md

给在本仓库工作的 agent / 贡献者的导引。注释、文档、commit message 用中文（与现有风格一致）。

## 这是什么

coflux：可跑在任意节点上的 **daemon**，本地起 PTY、驱动 Agent（claude/codex CLI），主动外连**中心服务器**；**client**（web）连服务器即可触达任意 daemon。模型类 Tailscale（账号 → 设备 → 项目 → 工作区 → 任务 → 会话）。

- `apps/server`（TS）：账号/设备认证 + 编排路由 + sqlite 持久化。
- `apps/web`（TS）：Vite + React + xterm 终端。
- `packages/{protocol,core}`（TS）：server/web 共享的线协议类型与日志。
- `crates/{protocol,supervisor,worker}`（Rust）：**daemon，全 Rust、零 node 运行时**。
  - `supervisor`：持 PTY(portable-pty) + scrollback + 背压；UDS server；起/管/重启 worker + 版本切换/观察期回滚。极少升级。
  - `worker`（tokio）：连服务器(WS)/认证/重连 + git/exec/fs + 两级 resync。频繁升级（热升级只换它，PTY 在 supervisor 存活）。
  - 详见 [docs/architecture.md](docs/architecture.md)、[docs/hot-upgrade-design.md](docs/hot-upgrade-design.md)、[docs/ROADMAP.md](docs/ROADMAP.md)。

## 常用命令

```sh
pnpm install                       # TS 依赖
pnpm -C tests test                 # 黑盒集成测试（pretest 自动 cargo build daemon 二进制）
cargo test -p coflux-protocol      # Rust 单元测试（帧 codec / serde 线格式）
cargo build -p coflux-supervisor -p coflux-worker   # 构建 daemon 二进制
node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit   # server 类型检查
node_modules/.bin/tsc -b apps/web/tsconfig.json               # web 类型检查
pnpm dev:server / dev:web / dev:daemon              # 本地起三端
deploy/install.sh --server ... --enroll-key ...     # 把 daemon 装成系统服务（systemd/launchd）
git tag v1.2.3 && git push origin v1.2.3            # 发版：触发交叉编译 + 签名 worker + GitHub Release（见 docs/RELEASING.md）
```

CI/发版：`.github/workflows/ci.yml`（push/PR 质量门）、`release.yml`（tag `v*` 发布）。worker 产物用 ed25519 签名、supervisor 验签，密钥设置见 [docs/RELEASING.md](docs/RELEASING.md)。

前置：Node 22+（server 用 `node:sqlite`）、pnpm、Rust stable（`rustup`）。

## 改动纪律

- **改协议**：`crates/protocol`（Rust 真相侧，daemon 用）与 `packages/protocol`（TS，server/web 用）两边都要改且保持线格式一致（内部标签 `type` + camelCase；数据面是二进制帧）。黑盒测试会抓行为漂移。
- **提交前必须绿**：相关 `tsc --noEmit` + `cargo build`（零警告）+ `pnpm -C tests test` 全过，再 commit。
- commit message 结尾带 `Co-Authored-By: Claude ...`。

## 测试 harness（重要）

这是本仓库质量的核心，且**刻意做成黑盒**，所以历经"TS daemon → 全 Rust daemon"的重写，同一套测试一路验证、无需改动。新功能优先用它验收。

### 形态与哲学

- 位置：`tests/src/`（`harness.mjs` + `*.test.mjs`），`node --test --test-concurrency=1` 顺序跑。
- **黑盒**：测试只通过**真实进程 + WebSocket 线协议**驱动，完全不碰应用内部实现 → 跨重构/跨语言重写有效。`harness.mjs` 里那份 pty 帧 codec 是**有意内联的纯 JS**（不 import 应用代码），就是为了不依赖被测物。
- `startStack()` 起一套独立的 **server(TS, tsx) + daemon(Rust supervisor 二进制，supervisor 再 spawn worker 二进制)**，等 daemon 在线后返回控制句柄；`Client` 是带 `waitFor` 的测试 WS 客户端；`mkRepo()` 造临时 git 仓库。
- daemon 默认用 `target/debug/coflux-{supervisor,worker}`（`pretest` 会 `cargo build`）；可用 `COFLUX_SUPERVISOR_BIN` / `COFLUX_WORKER_BIN` 覆盖路径。

### 隔离 / 不污染本地（关键约束）

每个 stack 都自带隔离，跑完即清，**绝不碰你真实环境**：

- **临时 HOME**：`COFLUX_HOME` 指向 `mkdtemp` 临时目录 → 设备凭证、`worker.pid`、下载产物等全落临时目录，不碰真实 `~/.coflux`。
- **临时 DB + 临时端口**：server 用临时 sqlite 文件 + 各测试文件独占端口（见各 `*.test.mjs` 顶部 `const PORT`，新增测试请选未占用端口）。
- **直接 spawn 二进制，不跑 launcher**：harness 直接拉起 supervisor 二进制，**从不执行 `deploy/install.sh`** → 不写 `~/.local/bin`、不注册 systemd/launchd、不动真实系统服务。
- **进程组清理**：daemon 以 `detached` 起在自己的进程组，`stop()` 用 `kill(-pid)` 杀整组（supervisor + worker + 其 PTY 子进程），再删临时目录。
- 调试：`COFLUX_TEST_DEBUG=1` 把 server/daemon 的 stdio 直通到终端。

### 签名 + 远程下载的验收（已实现，见 `tests/src/signed-upgrade.test.mjs`）

热升级"远程下载 + ed25519 验签"的验收，**头等用例是负向**：被篡改的产物（签名/sha256 不符）必须被拒、supervisor 保持当前版本。本地跑且不污染的隔离办法：

- **网络**：测试内起 `127.0.0.1` 临时 HTTP server（Node `http`，随机端口）服务测试产物；`worker.upgrade.url` 指向它。零外网。
- **密钥**：每次测试临时生成一对 ed25519（Node `crypto`，活在临时目录/内存）；公钥经 **env 注入** supervisor（`COFLUX_WORKER_PUBKEY`），覆盖二进制里 baked-in 的 prod 占位公钥。
  - *为何 env 注入不削弱安全*：签名防的是"中心服务器被攻破→推恶意产物"，不防本地（自有机器、本地可信）；而**被攻破的服务器无法设置你本地的 env**，所以公钥来自 baked-in 还是本地 env 对真实威胁没区别。
  - 跨语言：ed25519 / sha256 是标准的，Node `crypto`（原始 32B 公钥 + 64B 签名）与 Rust `ed25519-dalek` / `sha2` 互通。
- **文件系统/服务**：下载产物落临时 `COFLUX_HOME/workers/`；不跑 launcher → 不碰系统。

## Docker（更强隔离 / 可复现）

临时目录隔离已足够日常用；要**完全不碰宿主**或要**可复现环境**（CI、验收）时，用容器把整套（server + Rust daemon + 测试 + 临时 HTTP 产物 server）关在里面跑：

```sh
docker build -t coflux-test .                 # 构建测试环境镜像（node22 + rust + pnpm + 源码）
docker run --rm coflux-test                    # 默认 CMD = pnpm -C tests test，全套在容器内跑
docker run --rm coflux-test cargo test -p coflux-protocol   # 也可跑别的
```

容器内 127.0.0.1、临时目录、进程全独立，宿主的文件系统/网络/进程零改动。镜像把源码 COPY 进去构建（非挂载），故宿主工作树也不会被写入 `target/`、`node_modules/`。改了代码重建镜像即可（toolchain/依赖层有缓存）。

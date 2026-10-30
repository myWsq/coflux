# coflux 测试/验收用隔离环境：node22 + rust + pnpm + 源码。
# 整套（server + Rust daemon + 黑盒测试 + 临时 HTTP 产物 server）都在容器内跑，宿主零改动。
# 源码 COPY 进镜像构建（非挂载）→ 宿主工作树不会被写入 target/ 或 node_modules/。
FROM golang:1.27.1-bookworm AS transport-go
FROM node:22-bookworm
COPY --from=transport-go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
ENV CGO_ENABLED=0 GOTOOLCHAIN=go1.27.1

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates postgresql openssl xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Zig 0.17.x: the runtime's VT engine (libghostty-vt) is compiled from Ghostty's source during the
# cargo build. The base image is multi-arch (arm64 under OrbStack, x86_64 in CI), so pick the
# tarball by the image's architecture and verify ziglang.org's published SHA-256.
RUN set -e; arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) sum=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026 ;; \
      aarch64) sum=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8 ;; \
      *) echo "no Zig 0.17.0 tarball for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/zig.tar.xz "https://ziglang.org/download/0.17.0/zig-${arch}-linux-0.17.0.tar.xz"; \
    echo "${sum}  /tmp/zig.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/zig; tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; rm /tmp/zig.tar.xz; \
    ln -s /opt/zig/zig /usr/local/bin/zig; zig version

# Rust toolchain（minimal）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# pnpm（corepack）
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /work
COPY . .
RUN pnpm install --frozen-lockfile \
    && cargo build -p coflux-launcher -p coflux-runtime \
    && (cd transport/tailcat && go test ./...) \
    && node scripts/build-test-transports.mjs \
    && chmod +x scripts/docker-test-entrypoint.sh

# 每次容器启动都在自身临时目录拉起 loopback Postgres；测试建出的 database 与进程随容器销毁。
ENTRYPOINT ["/work/scripts/docker-test-entrypoint.sh"]

# 默认跑黑盒测试；也可 docker run ... 跑别的命令（入口仍会准备测试 Postgres）
CMD ["pnpm", "-C", "tests", "test"]

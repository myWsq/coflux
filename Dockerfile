# coflux 测试/验收用隔离环境：node22 + rust + pnpm + 源码。
# 整套（server + Rust daemon + 黑盒测试 + 临时 HTTP 产物 server）都在容器内跑，宿主零改动。
# 源码 COPY 进镜像构建（非挂载）→ 宿主工作树不会被写入 target/ 或 node_modules/。
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain（minimal）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# pnpm（corepack）
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /work
COPY . .
RUN pnpm install --frozen-lockfile \
    && cargo build -p coflux-supervisor -p coflux-worker

# 默认跑黑盒测试；也可 docker run ... 跑别的命令
CMD ["pnpm", "-C", "tests", "test"]

#!/bin/sh
set -eu

# initdb 拒绝 root；镜像安装 postgresql 时已创建 postgres 系统用户。数据目录位于容器临时层，
# 不挂宿主 volume，也不复用开发 compose 的实例。
test_pg_dir="$(mktemp -d /tmp/coflux-postgres.XXXXXX)"
test_pg_bin="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -n 1)"
chown postgres:postgres "$test_pg_dir"

runuser -u postgres -- "$test_pg_bin/initdb" \
  -D "$test_pg_dir" \
  --username=postgres \
  --auth=trust \
  --no-locale \
  --encoding=UTF8 >/dev/null

runuser -u postgres -- "$test_pg_bin/pg_ctl" \
  -D "$test_pg_dir" \
  -l "$test_pg_dir/postgres.log" \
  -o "-c listen_addresses=127.0.0.1 -p 5432 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
  -w start >/dev/null

exec "$@"

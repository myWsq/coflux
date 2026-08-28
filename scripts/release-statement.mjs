// 兼容旧 import 路径；实现放进随 cofluxd npm 包发布的模块，签名端与校验端共用同一 transcript。
export {
  WORKER_RELEASE_STATEMENT_DOMAIN as RELEASE_STATEMENT_DOMAIN,
  SUPERVISOR_RELEASE_STATEMENT_DOMAIN,
  assertReleaseVersion,
  supervisorReleaseStatement,
  workerReleaseStatement,
} from "../packages/cli/release-trust.mjs";

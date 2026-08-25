import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

export function ensureCodeSigningIdentity(identity) {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !`${result.stdout}${result.stderr}`.includes(identity)) {
    throw new Error(`缺少 ${identity} code-sign identity；Keychain/Hardened Runtime 门不能用 ad-hoc 代替`);
  }
}

export function signingBuildSettings({ team, identity, sandbox, networkClient, networkServer = false }) {
  return [
    `DEVELOPMENT_TEAM=${team}`,
    `CODE_SIGN_IDENTITY=${identity}`,
    "ENABLE_HARDENED_RUNTIME=YES",
    `ENABLE_APP_SANDBOX=${sandbox ? "YES" : "NO"}`,
    `ENABLE_OUTGOING_NETWORK_CONNECTIONS=${networkClient ? "YES" : "NO"}`,
    `ENABLE_INCOMING_NETWORK_CONNECTIONS=${networkServer ? "YES" : "NO"}`,
  ];
}

function extractPlistFromCodesign(appPath) {
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", appPath], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`读取 ${appPath} entitlements 失败`);
  const combined = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  const start = combined.indexOf("<?xml");
  if (start < 0) return {};
  const xml = combined.subarray(start);
  const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml });
  return JSON.parse(json.toString("utf8"));
}

function entitlementPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

export function auditSignedApp({ derivedDataPath, variant, team, identity, productName = "Coflux" }) {
  const appPath = join(derivedDataPath, "Build", "Products", "Debug", `${productName}.app`);
  execFileSync("codesign", ["--verify", "--strict", appPath], { stdio: "ignore" });
  const details = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const description = `${details.stdout}${details.stderr}`;
  const expectedAuthority = identity === "Apple Development" ? "Apple Development:" : identity;
  const authorities = description
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length));
  if (
    details.status !== 0
    || !description.includes("runtime")
    || !description.includes(`TeamIdentifier=${team}`)
    || typeof expectedAuthority !== "string"
    || !authorities.some((authority) => authority.startsWith(expectedAuthority))
  ) {
    throw new Error(`${variant.name} 产物没有真实 Development 签名 + Hardened Runtime`);
  }

  const entitlements = extractPlistFromCodesign(appPath);
  const sandbox = entitlements["com.apple.security.app-sandbox"] === true;
  const networkClient = entitlements["com.apple.security.network.client"] === true;
  const networkServer = entitlements["com.apple.security.network.server"] === true;
  const expectedNetworkServer = variant.networkServer === true;
  const absolutePathReadWrite = entitlementPresent(
    entitlements["com.apple.security.temporary-exception.files.absolute-path.read-write"],
  );
  if (
    sandbox !== variant.sandbox
    || networkClient !== variant.networkClient
    || networkServer !== expectedNetworkServer
  ) {
    throw new Error(
      `${variant.name} entitlement 不符：sandbox=${sandbox} network.client=${networkClient} network.server=${networkServer}`,
    );
  }
  if (absolutePathReadWrite) {
    throw new Error(
      `${variant.name} 包含不允许的 absolute-path.read-write exception`,
    );
  }

  const infoPath = join(appPath, "Contents", "Info.plist");
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", infoPath]).toString("utf8"));
  if (typeof info.NSLocalNetworkUsageDescription !== "string" || info.NSLocalNetworkUsageDescription.length === 0) {
    throw new Error(`${variant.name} 缺少 NSLocalNetworkUsageDescription`);
  }
  if (info.NSAppTransportSecurity?.NSAllowsArbitraryLoads === true) {
    throw new Error(`${variant.name} 不得用 NSAllowsArbitraryLoads 绕过 ATS`);
  }

  return {
    sandbox,
    networkClient,
    networkServer,
    developmentSigning: true,
    hardenedRuntime: true,
    atsArbitraryLoads: false,
    atsLocalNetworking: info.NSAppTransportSecurity?.NSAllowsLocalNetworking === true,
    localNetworkDescription: true,
    absolutePathReadWrite: false,
  };
}

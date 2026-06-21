/** 设备凭证的本地持久化（~/.coflux/credentials.json，chmod 600）。 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

export interface Credentials {
  serverUrl: string;
  daemonId: string;
  deviceToken: string;
}

export class CredentialStore {
  constructor(private path: string, private homeDir: string) {}

  load(): Credentials | null {
    try {
      const c = JSON.parse(readFileSync(this.path, "utf8")) as Credentials;
      return c.deviceToken ? c : null;
    } catch {
      return null;
    }
  }

  save(c: Credentials): void {
    mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(c, null, 2), { mode: 0o600 });
  }

  clear(): void {
    try {
      rmSync(this.path);
    } catch {
      /* ignore */
    }
  }
}

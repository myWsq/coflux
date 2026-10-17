/**
 * Unlock handoff for a locked remote Mac (plan 20261017-locked-screen-sharing-unlock): the lock
 * screen cannot be captured or typed into by the screen helper, so the user unlocks in macOS Screen
 * Sharing, pointed at the remote's own Screen Sharing (its loopback port 5900) through the device's
 * loopback tunnel. Coflux never sees a password; Apple's window talks to the remote directly.
 *
 * Main probes the remote's 5900 first, so a missing Screen Sharing / old runtime / unreachable device
 * comes back as a reason the page can explain, then opens `vnc://127.0.0.1:<port>` against a short-lived
 * forwarding listener. The listener is bound to loopback only, on a port the OS picks (never 5900:
 * Screen Sharing refuses to connect to the Mac it runs on). It has no authentication of its own, which
 * the remote's macOS account check and the short lifetime make acceptable; do not lengthen the
 * lifetime or bind wider without revisiting that.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { splice } from "./browser-proxy";
import { TunnelError } from "./loopback-tunnel";

/** The remote's Screen Sharing (VNC) port on its own loopback; fixed here, never taken from the page. */
const REMOTE_VNC_PORT = 5900;
/** A listener with no open connection for this long closes; live sockets are never cut by it. */
const IDLE_CLOSE_MS = 60_000;

export type ScreenSharingFailure = "offline" | "refused" | "unsupported";
export type ScreenSharingResult = { ok: true } | { ok: false; reason: ScreenSharingFailure };

export type ScreenSharingForwardOptions = {
  /** A connection to `port` on the device's loopback; rejects with a `TunnelError`. */
  connect: (daemonId: string, port: number) => Promise<Duplex>;
  /** Opens a URL in its handler app; called only with the `vnc:` URL built here. */
  openUrl: (url: string) => Promise<void>;
  log: (message: string, detail?: unknown) => void;
};

type Forward = {
  daemonId: string;
  server: Server;
  port: number;
  sockets: Set<Socket>;
  streams: Set<Duplex>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

export function createScreenSharingForward(options: ScreenSharingForwardOptions) {
  const forwards = new Map<string, Forward>();
  const starting = new Map<string, Promise<Forward>>();

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function armIdle(forward: Forward) {
    clearTimeout(forward.idleTimer);
    if (forward.sockets.size > 0) return;
    forward.idleTimer = setTimeout(() => destroy(forward), IDLE_CLOSE_MS);
    forward.idleTimer.unref?.();
  }

  function destroy(forward: Forward) {
    clearTimeout(forward.idleTimer);
    if (forwards.get(forward.daemonId) === forward) forwards.delete(forward.daemonId);
    forward.server.close();
    for (const socket of forward.sockets) socket.destroy();
    for (const stream of forward.streams) stream.destroy();
    forward.sockets.clear();
    forward.streams.clear();
  }

  function listen(daemonId: string): Promise<Forward> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      const forward: Forward = { daemonId, server, port: 0, sockets: new Set(), streams: new Set(), idleTimer: undefined };
      server.on("connection", (socket) => {
        forward.sockets.add(socket);
        clearTimeout(forward.idleTimer);
        socket.on("error", () => undefined);
        socket.on("close", () => {
          forward.sockets.delete(socket);
          armIdle(forward);
        });
        // Each accepted socket gets its own tunnel stream; they count against the lane's connection cap.
        socket.pause();
        options
          .connect(daemonId, REMOTE_VNC_PORT)
          .then((stream) => {
            if (socket.destroyed || forwards.get(daemonId) !== forward) {
              stream.destroy();
              return;
            }
            forward.streams.add(stream);
            stream.on("close", () => forward.streams.delete(stream));
            splice(socket, stream, Buffer.alloc(0));
          })
          .catch((error) => {
            options.log("screen sharing forward: tunnel connect failed", { daemonId, error: message(error) });
            socket.destroy();
          });
      });
      server.once("error", reject);
      // Loopback only: a bare listen(0) would bind every interface and expose the remote's VNC port to the LAN.
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (error) => options.log("screen sharing forward: listener error", { daemonId, error: error.message }));
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("no listener address"));
          return;
        }
        forward.port = address.port;
        forwards.set(daemonId, forward);
        armIdle(forward);
        resolve(forward);
      });
    });
  }

  async function forwardFor(daemonId: string): Promise<Forward> {
    const existing = forwards.get(daemonId);
    if (existing) {
      armIdle(existing);
      return existing;
    }
    let pending = starting.get(daemonId);
    if (!pending) {
      pending = listen(daemonId).finally(() => starting.delete(daemonId));
      starting.set(daemonId, pending);
    }
    return pending;
  }

  /** Probes the remote's Screen Sharing, then opens Apple's app on a loopback forward to it. */
  async function open(daemonId: string): Promise<ScreenSharingResult> {
    try {
      // The probe stream is classification only: a VNC server speaks first, so it is never reused.
      const probe = await options.connect(daemonId, REMOTE_VNC_PORT);
      probe.on("error", () => undefined);
      probe.destroy();
    } catch (error) {
      const reason: ScreenSharingFailure = error instanceof TunnelError ? error.reason : "offline";
      options.log("screen sharing probe failed", { daemonId, reason, error: message(error) });
      return { ok: false, reason };
    }
    try {
      const forward = await forwardFor(daemonId);
      await options.openUrl(`vnc://127.0.0.1:${forward.port}`);
      return { ok: true };
    } catch (error) {
      options.log("screen sharing could not be opened", { daemonId, error: message(error) });
      return { ok: false, reason: "offline" };
    }
  }

  /** The device's screen session is gone: the listener and everything live on it go too. */
  function closeDevice(daemonId: string) {
    const forward = forwards.get(daemonId);
    if (forward) destroy(forward);
  }

  function dispose() {
    for (const forward of [...forwards.values()]) destroy(forward);
  }

  return { open, closeDevice, dispose };
}

export type ScreenSharingForward = ReturnType<typeof createScreenSharingForward>;

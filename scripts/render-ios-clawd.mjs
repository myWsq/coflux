#!/usr/bin/env node
// Renders the desktop's Clawd poses (apps/desktop/src/renderer/assets/clawd/*.svg, driven frame by
// frame in clawd-glyph.tsx) into PNG frames for the iOS app, so the iPhone plays the same frames
// with the same timing. Headless Chrome applies each frame exactly as the desktop does (which
// layers show, which transforms move), measures the union of every frame's bounds — confetti and
// the flag reach outside the character's box — and rasterises each frame at @3x.
//
// Output (both generated, both committed):
//   apps/ios/Coflux/Assets.xcassets/Clawd/clawd-<pose>-<nn>.imageset
//   apps/ios/Coflux/Views/ClawdFrames.generated.swift  (per-pose view box, bounds, frame count)
//
// Run after changing the desktop SVGs: node scripts/render-ios-clawd.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svgDir = path.join(root, "apps/desktop/src/renderer/assets/clawd");
const assetDir = path.join(root, "apps/ios/Coflux/Assets.xcassets/Clawd");
const swiftFile = path.join(root, "apps/ios/Coflux/Views/ClawdFrames.generated.swift");
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The glyph box the frames are rendered for, in points (the view box is fitted into it, meet, as on the desktop): above the sizes iOS shows, so they only scale down. */
const GLYPH_PT = 24;
const SCALE = 3;

const svgs = Object.fromEntries(
  ["gym", "flag", "confetti"].map((name) => [name, fs.readFileSync(path.join(svgDir, `${name}.svg`), "utf8")]),
);

// Runs in the page. Mirrors clawd-glyph.tsx: prepare(), showOnly(), and each pose's frame setup.
const pageScript = `
const SVGS = ${JSON.stringify(svgs)};
const GLYPH_PT = ${GLYPH_PT}, SCALE = ${SCALE};
const CONFETTI_Y = [-65, -72, -76, -70, -58, -42, -22, 0];
const FLAG_HAND_X = [0, -6, -12, -14, -8, -2, 0, 0, -4, -10, -16, -18];
const FLAG_SWAY_X = [0, 0, -5, -5, 0, 4, 4, 4, 0, 0, -5, -5];
const FLAG_LEFT_HAND_Y = [0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 4, 4];
const prepare = (raw) => raw
  .replace(/#DD775B/gi, "#D97757")
  .replace(/\\sclass="[^"]*"/g, "")
  .replace(/\\sid="[^"]*"/g, "")
  .replace(/\\sdata-svg-origin="[^"]*"/g, "");
const kids = (parent, tag) => [...parent.children].filter((el) => el.tagName === tag);
const showOnly = (els, index) => els.forEach((el, i) => { el.style.display = i === index ? "inline" : "none"; });

// Each pose: how many distinct frames, and how to put the SVG into frame n.
const POSES = {
  gym: { svg: "gym", count: 36, setup: () => {}, frame: (svg, n) => showOnly(kids(svg, "g"), n) },
  flag: {
    svg: "flag",
    count: 12,
    setup: (svg) => {
      const body = kids(svg, "g")[0];
      const handGroup = body.children[8];
      body.removeAttribute("transform"); body.style.transform = "";
      handGroup.removeAttribute("transform"); handGroup.style.transform = "";
    },
    frame: (svg, n) => {
      const body = kids(svg, "g")[0];
      const leftHand = body.children[5];
      const handGroup = body.children[8];
      body.setAttribute("transform", "translate(" + FLAG_SWAY_X[n] + ", 0)");
      handGroup.setAttribute("transform", "translate(" + FLAG_HAND_X[n] + ", 0)");
      leftHand.setAttribute("transform", "translate(0, " + FLAG_LEFT_HAND_Y[n] + ")");
      showOnly(kids(handGroup, "g"), n);
    },
  },
  // Ticks 0…13: 0…5 are the run-up (bursts not yet both out), 6…13 the steady 8-tick loop.
  confetti: {
    svg: "confetti",
    count: 14,
    setup: () => {},
    frame: (svg, i) => {
      const groups = kids(svg, "g");
      showOnly(groups.slice(0, 8), i % 8);
      const bursts = [[groups[8], i - 1, (f) => "translate(90, " + (-22 + CONFETTI_Y[f]) + ")"],
                      [groups[9], i - 6, (f) => "translate(40, " + (-72 + CONFETTI_Y[f]) + ") scale(-1, 1)"]];
      for (const [burst, b, transform] of bursts) {
        if (b >= 0) {
          const f = b % 8;
          burst.setAttribute("style", "display: inline");
          burst.setAttribute("transform", transform(f));
          showOnly(kids(burst, "g"), f);
        } else {
          burst.setAttribute("style", "display: none");
        }
      }
    },
  },
};

const raster = (markup, w, h) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    resolve(canvas.toDataURL("image/png"));
  };
  img.onerror = reject;
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
});

(async () => {
  const out = {};
  for (const [pose, spec] of Object.entries(POSES)) {
    const host = document.createElement("div");
    host.innerHTML = prepare(SVGS[spec.svg]);
    document.body.appendChild(host);
    const svg = host.querySelector("svg");
    svg.removeAttribute("style");
    svg.setAttribute("width", "400"); svg.setAttribute("height", "400");
    const vb = svg.viewBox.baseVal;
    spec.setup(svg);
    // Union of every frame's bounds and the view box, in view-box units.
    let x0 = vb.x, y0 = vb.y, x1 = vb.x + vb.width, y1 = vb.y + vb.height;
    for (let n = 0; n < spec.count; n++) {
      spec.frame(svg, n);
      const b = svg.getBBox();
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    }
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
    const pxPerUnit = GLYPH_PT * SCALE / Math.max(vb.width, vb.height);
    const w = Math.ceil((x1 - x0) * pxPerUnit), h = Math.ceil((y1 - y0) * pxPerUnit);
    const frames = [];
    for (let n = 0; n < spec.count; n++) {
      spec.frame(svg, n);
      const clone = svg.cloneNode(true);
      clone.setAttribute("viewBox", [x0, y0, x1 - x0, y1 - y0].join(" "));
      clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
      clone.setAttribute("preserveAspectRatio", "none");
      frames.push(await raster(new XMLSerializer().serializeToString(clone), w, h));
    }
    out[pose] = { viewBox: [vb.x, vb.y, vb.width, vb.height], bounds: [x0, y0, x1 - x0, y1 - y0], frames };
    host.remove();
  }
  const pre = document.createElement("pre");
  pre.id = "out";
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-"));
try {
  const page = path.join(tmp, "render.html");
  fs.writeFileSync(page, `<!doctype html><html><body><script>${pageScript}</script></body></html>`);
  const dom = execFileSync(
    chrome,
    ["--headless=new", "--disable-gpu", "--virtual-time-budget=20000", "--dump-dom", `file://${page}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const match = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!match) throw new Error("Chrome produced no frames");
  const poses = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n");
  for (const [pose, data] of Object.entries(poses)) {
    data.frames.forEach((url, n) => {
      const name = `clawd-${pose}-${String(n).padStart(2, "0")}`;
      const set = path.join(assetDir, `${name}.imageset`);
      fs.mkdirSync(set);
      fs.writeFileSync(path.join(set, `${name}.png`), Buffer.from(url.split(",")[1], "base64"));
      fs.writeFileSync(
        path.join(set, "Contents.json"),
        JSON.stringify(
          {
            images: [
              { idiom: "universal", scale: "1x" },
              { idiom: "universal", scale: "2x" },
              { filename: `${name}.png`, idiom: "universal", scale: "3x" },
            ],
            info: { author: "xcode", version: 1 },
          },
          null,
          2,
        ) + "\n",
      );
    });
  }

  const rect = (r) => `CGRect(x: ${r[0]}, y: ${r[1]}, width: ${r[2]}, height: ${r[3]})`;
  const entries = Object.entries(poses)
    .map(([pose, d]) => `        case .${pose}: Sheet(viewBox: ${rect(d.viewBox)}, bounds: ${rect(d.bounds)}, count: ${d.frames.length})`)
    .join("\n");
  fs.writeFileSync(
    swiftFile,
    `// Generated by scripts/render-ios-clawd.mjs — do not edit.
import CoreGraphics

extension ClawdSheet {
    /// Each sheet's view box and the union of its frames' bounds (both in view-box units), and its
    /// number of frames (assets \`clawd-<sheet>-00\`…).
    static func sheet(_ sheet: ClawdSheet) -> Sheet {
        switch sheet {
${entries}
        }
    }

    /// The glyph box the frames were rendered for, in points.
    static let renderedGlyphSize: CGFloat = ${GLYPH_PT}
}
`,
  );
  const counts = Object.entries(poses).map(([p, d]) => `${p} ${d.frames.length}`).join(", ");
  console.log(`wrote ${counts} frames to ${path.relative(root, assetDir)}`);
} finally {
  if (tmp && tmp.startsWith(os.tmpdir())) fs.rmSync(tmp, { recursive: true, force: true });
}

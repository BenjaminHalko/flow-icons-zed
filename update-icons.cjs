#!/usr/bin/env node
"use strict";

/**
 * Flow Icons Updater for Zed
 * Usage: node update-icons.cjs [LICENSE_KEY]
 *    or: FLOW_ICONS_LICENSE=<key> node update-icons.cjs
 *
 * Without a license key, downloads demo icons from the VSIX on Open VSX.
 * With a license key, downloads premium icons from the Flow Icons API.
 *
 * Zero dependencies — uses Node built-in zlib (brotli + deflate) and manual
 * tar/zip extraction.
 */

const https = require("https");
const { brotliDecompressSync, inflateRawSync } = require("zlib");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Configuration
const SCRIPT_DIR = __dirname;
const ICONS_DIR = path.join(SCRIPT_DIR, "icons");
const THEME_DIR = path.join(SCRIPT_DIR, "icon_themes");
const VERSION_FILE = path.join(SCRIPT_DIR, ".icon-version");
const CONFIG_FILE = path.join(SCRIPT_DIR, "config.json");
// Association source + pack manifests shipped beside the SVGs. `icons.json`
// is the always-on set; `define.json` holds associations that only apply when
// an icon pack is enabled; `settings.json` lists which icon ids belong to
// each pack. Mirrors the VS Code extension.
const ICONS_MANIFEST = path.join(ICONS_DIR, "icons.json");
const DEFINE_MANIFEST = path.join(ICONS_DIR, "define.json");
const PACK_SETTINGS_FILE = path.join(ICONS_DIR, "settings.json");
const USER_AGENT = "Flow Icons";
const API_BASE = "https://legit-i9lq.onrender.com/flow-icons";

// Colors
const C = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  nc: "\x1b[0m",
};

// ---------------------------------------------------------------------------
// Flow You palette defaults
// ---------------------------------------------------------------------------
//
// The VS Code extension ships SVG templates under `extension/icons/` whose
// fills are written as CSS-variable-like tokens (e.g. `fill="--blue"`). The
// extension's "Rebuild Icons" command does a plain string replace to swap
// each `--<name>` for the user's chosen hex color, then writes the result
// into `you/` (dark) and `you-light/` (light) folders.
//
// We mirror that exact pipeline here so the Zed port behaves identically.
// The base palettes below are the monochromatic slate defaults from the
// extension's `colors.js` (after `fillColors` has populated contrast/border).

const BASE_PALETTE_YOU = {
  white: "#f8fafc",
  black: "#1e293b",
  blue: "#94a3b8",
  brown: "#94a3b8",
  gray: "#94a3b8",
  green: "#94a3b8",
  lime: "#94a3b8",
  orange: "#94a3b8",
  pink: "#94a3b8",
  purple: "#94a3b8",
  red: "#94a3b8",
  sky: "#94a3b8",
  teal: "#94a3b8",
  yellow: "#94a3b8",
  borderOpacity: 0.1,
  contrast: "#f8fafc",
  border: "#f8fafc",
};

const BASE_PALETTE_YOU_LIGHT = {
  white: "#f1f5f9",
  black: "#0f172a",
  blue: "#64748b",
  brown: "#64748b",
  gray: "#64748b",
  green: "#64748b",
  lime: "#64748b",
  orange: "#64748b",
  pink: "#64748b",
  purple: "#64748b",
  red: "#64748b",
  sky: "#64748b",
  teal: "#64748b",
  yellow: "#64748b",
  borderOpacity: 0.1,
  contrast: "#0f172a",
  border: "#0f172a",
};

// Color keys the user is allowed to override. Anything else gets dropped on
// load. `border` and `contrast` are documented as overridable in the upstream
// readme even though the extension's own normalizeColors strips them; we
// honour the documented behaviour here.
const ALLOWED_COLOR_KEYS = new Set([
  "white",
  "black",
  "blue",
  "brown",
  "gray",
  "green",
  "lime",
  "orange",
  "pink",
  "purple",
  "red",
  "sky",
  "teal",
  "yellow",
  "border",
  "contrast",
  "borderOpacity",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMachineId() {
  return crypto.createHash("md5").update(os.hostname()).digest("hex");
}

// Match the original VS Code extension: users may write either hyphen or
// underscore form (e.g. "rust-alt" or "rust_alt"). SVG filenames on disk use
// underscores, so we normalize to that form when looking icons up.
function normalizeIconName(name) {
  return (name || "").replace(/-/g, "_");
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    console.log(
      `${C.yellow}Warning: failed to parse config.json (${e.message}); ignoring${C.nc}`,
    );
    return null;
  }
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(
      `${C.yellow}Warning: failed to parse ${path.basename(file)} (${e.message}); ignoring${C.nc}`,
    );
    return null;
  }
}

// Public pack list from https://github.com/thang-nm/Flow-Icons/blob/main/settings.json
// Used when the downloaded icon set has no settings.json of its own.
const DEFAULT_PACK_SETTINGS = {
  defaults: {
    packs: {
      angular: true,
      bashly: true,
      nest: false,
      next: true,
      roblox: true,
    },
  },
  packs: {
    angular: [
      "angular_component",
      "angular_controller",
      "angular_directive",
      "angular_guard",
      "angular_interceptor",
      "angular_interface",
      "angular_module",
      "angular_pipe",
      "angular_routing",
      "angular_service",
    ],
    bashly: ["bashly_hook"],
    nest: [
      "nest_controller",
      "nest_dto",
      "nest_entity",
      "nest_guard",
      "nest_interceptor",
      "nest_interface",
      "nest_middleware",
      "nest_module",
      "nest_pipe",
      "nest_repository",
      "nest_service",
    ],
    next: [
      "next_js_error",
      "next_js_layout",
      "next_js_loading",
      "next_js_not_found",
      "next_js_page",
      "next_js_route",
      "next_js_template",
      "next_jsx_error",
      "next_jsx_layout",
      "next_jsx_loading",
      "next_jsx_not_found",
      "next_jsx_page",
      "next_jsx_template",
      "next_ts_error",
      "next_ts_layout",
      "next_ts_loading",
      "next_ts_not_found",
      "next_ts_page",
      "next_ts_route",
      "next_ts_template",
    ],
    roblox: ["rojo"],
  },
};

function resolveActiveIconPacks(config, packSettings) {
  const defaults = {
    ...DEFAULT_PACK_SETTINGS.defaults.packs,
    ...(packSettings?.defaults?.packs || {}),
  };
  const active = { ...defaults };
  for (const [name, enabled] of Object.entries(config?.activeIconPack || {})) {
    if (typeof enabled === "boolean") active[name] = enabled;
  }
  return active;
}

// Copy enabled pack associations from define.json onto the base manifest.
// Same rule as the VS Code extension: a pack icon id that starts with
// `folder_` is a folder association; everything else is a file association.
// Packs are applied in settings order, so when angular and nest are both on,
// nest wins for filenames they both claim.
function mergeActiveIconPacks(
  files,
  folders,
  defineManifest,
  packSettings,
  active,
  iconsFolder,
  explicitPacks,
  warnings,
) {
  const defineFiles = defineManifest?.files || {};
  const defineFolders = defineManifest?.folders || {};
  const packIcons = {
    ...DEFAULT_PACK_SETTINGS.packs,
    ...(packSettings?.packs || {}),
  };
  const unavailable = [];

  for (const [pack, enabled] of Object.entries(active)) {
    if (enabled !== true) continue;
    const ids = packIcons[pack];
    if (!ids) {
      if (explicitPacks[pack] === true) {
        warnings.add(`Unknown icon pack "${pack}"`);
      }
      continue;
    }

    let applied = 0;
    for (const rawId of ids) {
      const iconId = normalizeIconName(rawId);
      if (!iconId) continue;
      if (iconId.startsWith("folder_")) {
        const folderId = iconId.slice("folder_".length);
        const def = defineFolders[folderId];
        if (!def) continue;
        if (!fs.existsSync(path.join(iconsFolder, `folder_${folderId}.svg`))) {
          warnings.add(
            `Icon pack "${pack}": missing folder_${folderId}.svg, skipped`,
          );
          continue;
        }
        folders[folderId] = def;
        applied++;
      } else {
        const def = defineFiles[iconId];
        if (!def) continue;
        if (!fs.existsSync(path.join(iconsFolder, `${iconId}.svg`))) {
          warnings.add(`Icon pack "${pack}": missing ${iconId}.svg, skipped`);
          continue;
        }
        files[iconId] = def;
        applied++;
      }
    }

    if (applied === 0 && explicitPacks[pack] === true) unavailable.push(pack);
  }

  if (unavailable.length) {
    warnings.add(
      `Icon packs ${unavailable.join(", ")} are enabled, but this icon set does not include their icons. Pack icons ship with the premium download.`,
    );
  }
}

// Move a manifest entry's associations onto another icon id. Names already
// attached to the target stay, so `components` -> `react-components` retargets
// the components folders without dropping react / jsx.
function retargetManifestEntry(table, src, target) {
  const data = table[src];
  delete table[src];
  const existing = table[target];
  if (!existing) {
    table[target] = data;
    return;
  }
  table[target] = {
    l: [...(existing.l || []), ...(data.l || [])],
    e: [...(existing.e || []), ...(data.e || [])],
    n: [...(existing.n || []), ...(data.n || [])],
  };
}

function applyManifestReplacements(files, folders, config, iconsFolder, folderName) {
  for (const [rawSrc, rawTarget] of Object.entries(
    config?.filesReplacements || {},
  )) {
    const src = normalizeIconName(rawSrc);
    const target = normalizeIconName(rawTarget);
    if (!src || !target || !files[src]) continue;
    if (!fs.existsSync(path.join(iconsFolder, `${target}.svg`))) {
      console.log(
        `${C.yellow}  filesReplacements ${rawSrc} -> ${rawTarget}: missing ${target}.svg in ${folderName}, skipped${C.nc}`,
      );
      continue;
    }
    retargetManifestEntry(files, src, target);
  }

  for (const [rawSrc, rawTarget] of Object.entries(
    config?.foldersReplacements || {},
  )) {
    const src = normalizeIconName(rawSrc);
    const target = normalizeIconName(rawTarget);
    if (!src || !target || !folders[src]) continue;
    if (!fs.existsSync(path.join(iconsFolder, `folder_${target}.svg`))) {
      console.log(
        `${C.yellow}  foldersReplacements ${rawSrc} -> ${rawTarget}: missing folder_${target}.svg in ${folderName}, skipped${C.nc}`,
      );
      continue;
    }
    retargetManifestEntry(folders, src, target);
  }
}

function expandManifest(files, folders) {
  const fileExtensions = {};
  const fileNames = {};
  const folderNames = {};
  const folderNamesExpanded = {};

  for (const [iconId, data] of Object.entries(files)) {
    if (!data) continue;
    for (const ext of data.e || []) fileExtensions[ext] = iconId;
    for (const name of data.n || []) fileNames[name] = iconId;
  }
  for (const [folderId, data] of Object.entries(folders)) {
    if (!data) continue;
    const collapsed = `folder_${folderId}`;
    const expanded = `${collapsed}_open`;
    for (const name of data.n || []) {
      folderNames[name] = collapsed;
      folderNamesExpanded[name] = expanded;
    }
  }
  return { fileExtensions, fileNames, folderNames, folderNamesExpanded };
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        // Follow one redirect
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          return httpGet(res.headers.location, headers).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
        );
      })
      .on("error", (err) =>
        reject(new Error(`Connection error: ${err.message}`)),
      );
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const OPENVSX_API = "https://open-vsx.org/api/thang-nm/flow-icons";

async function getExtensionInfo() {
  const { status, body } = await httpGet(OPENVSX_API, {
    "user-agent": USER_AGENT,
  });
  if (status !== 200)
    throw new Error(`Open VSX error (${status}): ${body.toString()}`);
  const info = JSON.parse(body.toString());
  return {
    version: info.version,
    vsixUrl: info.files?.download,
  };
}

async function getLatestVersion(licenseKey, machineId, extensionVersion) {
  const url = `${API_BASE}/version-3?v=${extensionVersion}`;
  const { status, body } = await httpGet(url, {
    authorization: licenseKey,
    "machine-id": machineId,
    "user-agent": `${USER_AGENT}/${extensionVersion}`,
  });
  if (status !== 200)
    throw new Error(`Server error (${status}): ${body.toString()}`);
  return JSON.parse(body.toString());
}

async function download(url) {
  const { status, body } = await httpGet(url, {});
  if (status !== 200)
    throw new Error(`Download failed (${status}): ${body.toString()}`);
  return body;
}

// ---------------------------------------------------------------------------
// Color math (ported from the VS Code extension's colors.js)
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h;
  let s;
  const l = (max + min) / 2;
  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  h /= 360;
  s /= 100;
  l /= 100;
  let r;
  let g;
  let b;
  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      let t2 = t;
      if (t2 < 0) t2 += 1;
      if (t2 > 1) t2 -= 1;
      if (t2 < 1 / 6) return p + (q - p) * 6 * t2;
      if (t2 < 1 / 2) return q;
      if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
      .toLowerCase()
  );
}

// Auto-derive a light-mode color from a dark-mode color. Matches the
// extension's heuristic: bump saturation slightly, drop lightness by 8.
function darken(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s0, l0] = rgbToHsl(r, g, b);
  const s = Math.max(0, Math.min(100, s0 + (s0 > 90 ? 1 : 8)));
  const l = Math.max(0, Math.min(100, l0 - 8));
  const [r2, g2, b2] = hslToRgb(h, s, l);
  return rgbToHex(r2, g2, b2);
}

function invert(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(255 - r, 255 - g, 255 - b);
}

// Keep only the canonical color keys; mirrors the extension's
// normalizeColors. Returns a new object so the caller's input is untouched.
function filterAllowedColors(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input)) {
    if (ALLOWED_COLOR_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Flow You builder
// ---------------------------------------------------------------------------

const FLOW_YOU_TEMPLATE_DIR = path.join(ICONS_DIR, "icons");

// Generate `you/` and `you-light/` from the template SVGs in `icons/` by
// substituting `--<colorName>` placeholders with the user's chosen palette.
//
// Contract: the source templates contain tokens like `fill="--blue"` and
// `fill-opacity="--borderOpacity"`. We replace longest names first so
// `--borderOpacity` is consumed before `--border` would match its prefix.
function buildYouIcons(userColors) {
  if (!fs.existsSync(FLOW_YOU_TEMPLATE_DIR)) {
    throw new Error(
      `Template folder missing: ${FLOW_YOU_TEMPLATE_DIR}. ` +
        `Delete .icon-version and rerun to force a re-download.`,
    );
  }

  // Split user input into dark (top-level) + light (nested override).
  const { light: lightInput, ...darkInput } = userColors || {};
  const dark = filterAllowedColors(darkInput);
  const light = filterAllowedColors(lightInput);

  // Auto-derive missing light entries from dark, matching the extension.
  for (const [key, value] of Object.entries(dark)) {
    if (key === "border" || key === "contrast") continue;
    if (light[key] != null) continue;
    light[key] =
      typeof value === "string" && value.startsWith("#")
        ? darken(value)
        : value;
  }

  // Ensure contrast/border exist. The extension's fillColors uses white in
  // dark mode and black in light mode; we follow the same rule but also let
  // the user pre-fill either explicitly. Only assign when the source value
  // is actually defined — otherwise we'd add a `contrast: undefined` /
  // `border: undefined` property here that would overwrite the base
  // palette's hex defaults during the spread merge below and end up
  // substituted as the literal string "undefined" in the generated SVGs.
  if (dark.contrast == null && dark.white != null) dark.contrast = dark.white;
  if (dark.border == null && dark.contrast != null) dark.border = dark.contrast;
  if (light.contrast == null && light.black != null) {
    light.contrast = light.black;
  }
  if (light.border == null && dark.border != null) {
    light.border = invert(dark.border);
  } else if (light.border == null && light.contrast != null) {
    light.border = light.contrast;
  }

  const variants = [
    { name: "you", base: BASE_PALETTE_YOU, override: dark },
    { name: "you-light", base: BASE_PALETTE_YOU_LIGHT, override: light },
  ];

  const templateFiles = fs
    .readdirSync(FLOW_YOU_TEMPLATE_DIR)
    .filter((f) => f.endsWith(".svg") && !f.startsWith("._"))
    .sort();

  for (const { name, base, override } of variants) {
    const destFolder = path.join(ICONS_DIR, name);
    // Rebuild from scratch so stale icons from previous configs are removed.
    fs.rmSync(destFolder, { recursive: true, force: true });
    fs.mkdirSync(destFolder, { recursive: true });

    const merged = { ...base, ...override };
    const sortedEntries = Object.entries(merged).sort(
      (a, b) => b[0].length - a[0].length,
    );

    for (const file of templateFiles) {
      const sourcePath = path.join(FLOW_YOU_TEMPLATE_DIR, file);
      const destPath = path.join(destFolder, file);
      let content = fs.readFileSync(sourcePath, "utf8");
      for (const [colorName, value] of sortedEntries) {
        // Color names are alphanumeric; safe to interpolate into RegExp.
        content = content.replace(
          new RegExp(`--${colorName}`, "g"),
          String(value),
        );
      }
      fs.writeFileSync(destPath, content);
    }
  }
}

// ---------------------------------------------------------------------------
// Tar extraction
// ---------------------------------------------------------------------------

function extractTar(buffer, outputDir) {
  let offset = 0;
  while (offset < buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    const name = header.toString("utf8", 0, 100).replace(/\0/g, "").trim();
    const size = parseInt(header.toString("utf8", 124, 136).trim() || "0", 8);

    if (!name) break;
    offset += 512;

    if (size > 0) {
      // Skip macOS metadata files and PAX headers
      if (
        !name.includes("/._") &&
        !name.startsWith("._") &&
        !name.includes("PaxHeader")
      ) {
        const content = buffer.slice(offset, offset + size);
        const filePath = path.join(outputDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      }
      offset += Math.ceil(size / 512) * 512;
    }
  }
}

function extractIcons(compressedData, outputDir) {
  const decompressed = brotliDecompressSync(compressedData);
  extractTar(decompressed, outputDir);
}

// ---------------------------------------------------------------------------
// ZIP extraction
// ---------------------------------------------------------------------------

function extractZip(buffer, outputDir, stripPrefix, filter) {
  // Find End of Central Directory record by scanning backward
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid ZIP: EOCD not found");

  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  let extracted = 0;
  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const fnLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const filename = buffer.toString("utf8", offset + 46, offset + 46 + fnLen);
    offset += 46 + fnLen + extraLen + commentLen;

    // Skip directories
    if (filename.endsWith("/")) continue;

    // Strip prefix (e.g. "extension/")
    let outName = filename;
    if (stripPrefix && outName.startsWith(stripPrefix)) {
      outName = outName.slice(stripPrefix.length);
    }
    if (!outName) continue;

    // Apply filter if provided
    if (filter && !filter(outName)) continue;

    // Locate file data via local file header
    const localFnLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localFnLen + localExtraLen;
    const raw = buffer.slice(dataOffset, dataOffset + compSize);

    let content;
    if (method === 0) {
      content = raw;
    } else if (method === 8) {
      content = inflateRawSync(raw);
    } else {
      continue; // Unsupported method
    }

    const filePath = path.join(outputDir, outName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    extracted++;
  }
  return extracted;
}

function readZipEntry(buffer, targetName, stripPrefix) {
  // Read a single file from a ZIP buffer and return its contents
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const fnLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const filename = buffer.toString("utf8", offset + 46, offset + 46 + fnLen);
    offset += 46 + fnLen + extraLen + commentLen;

    let name = filename;
    if (stripPrefix && name.startsWith(stripPrefix))
      name = name.slice(stripPrefix.length);
    if (name !== targetName) continue;

    const localFnLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localFnLen + localExtraLen;
    const raw = buffer.slice(dataOffset, dataOffset + compSize);

    if (method === 0) return raw;
    if (method === 8) return inflateRawSync(raw);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version tracking
// ---------------------------------------------------------------------------

function getCurrentVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

function saveVersion(version) {
  fs.writeFileSync(VERSION_FILE, version);
}

function countIcons(folder) {
  const dir = path.join(ICONS_DIR, folder);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".svg") && !f.startsWith("._")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Theme builder
// ---------------------------------------------------------------------------

function buildFileIcons(iconsFolder, folderName) {
  const fileIcons = { default: { path: `./icons/${folderName}/file.svg` } };
  for (const file of fs.readdirSync(iconsFolder).sort()) {
    if (!file.endsWith(".svg") || file.startsWith("._")) continue;
    const iconId = path.parse(file).name;
    if (iconId.startsWith("folder_")) continue;
    fileIcons[iconId] = { path: `./icons/${folderName}/${iconId}.svg` };
  }
  return fileIcons;
}

function addCaseVariations(mapping) {
  const result = { ...mapping };
  for (const [key, value] of Object.entries(mapping)) {
    result[key.toLowerCase()] = value;
    result[key.charAt(0).toUpperCase() + key.slice(1)] = value;
    if (key.includes(".")) {
      const lastDot = key.lastIndexOf(".");
      const stem = key.slice(0, lastDot);
      const ext = key.slice(lastDot + 1);
      result[`${stem.toUpperCase()}.${ext.toLowerCase()}`] = value;
    } else {
      result[key.toUpperCase()] = value;
    }
  }
  return result;
}

function buildThemeFromVscodeJson(
  vscodeThemePath,
  folderName,
  iconsFolder,
  config,
  packContext,
) {
  let fileExtensions;
  let fileNames;
  let folderNames;
  let folderNamesExpanded;

  // Prefer icons.json + define.json so activeIconPack can add or omit pack
  // associations. The prebuilt palette JSON is the fallback for icon sets
  // downloaded before those manifests were kept.
  if (packContext?.iconsManifest) {
    const files = { ...(packContext.iconsManifest.files || {}) };
    const folders = { ...(packContext.iconsManifest.folders || {}) };
    mergeActiveIconPacks(
      files,
      folders,
      packContext.defineManifest,
      packContext.packSettings,
      packContext.active,
      iconsFolder,
      packContext.explicitPacks,
      packContext.warnings,
    );
    applyManifestReplacements(files, folders, config, iconsFolder, folderName);
    ({ fileExtensions, fileNames, folderNames, folderNamesExpanded } =
      expandManifest(files, folders));
  } else if (fs.existsSync(vscodeThemePath)) {
    const vscodeTheme = JSON.parse(fs.readFileSync(vscodeThemePath, "utf8"));
    fileExtensions = { ...(vscodeTheme.fileExtensions || {}) };
    fileNames = { ...(vscodeTheme.fileNames || {}) };
    folderNames = { ...(vscodeTheme.folderNames || {}) };
    folderNamesExpanded = { ...(vscodeTheme.folderNamesExpanded || {}) };

    // Apply file replacements: anywhere "<src>" icon ID was used, swap to "<target>".
    // Mirrors the original VS Code extension's flow-icons.files.replacements.
    for (const [rawSrc, rawTarget] of Object.entries(
      config?.filesReplacements || {},
    )) {
      const src = normalizeIconName(rawSrc);
      const target = normalizeIconName(rawTarget);
      if (!src || !target) continue;
      if (!fs.existsSync(path.join(iconsFolder, `${target}.svg`))) {
        console.log(
          `${C.yellow}  filesReplacements ${rawSrc} -> ${rawTarget}: missing ${target}.svg in ${folderName}, skipped${C.nc}`,
        );
        continue;
      }
      for (const [k, v] of Object.entries(fileExtensions)) {
        if (v === src) fileExtensions[k] = target;
      }
      for (const [k, v] of Object.entries(fileNames)) {
        if (v === src) fileNames[k] = target;
      }
    }

    // Apply folder replacements: values in folderNames are "folder_<id>" form.
    for (const [rawSrc, rawTarget] of Object.entries(
      config?.foldersReplacements || {},
    )) {
      const src = normalizeIconName(rawSrc);
      const target = normalizeIconName(rawTarget);
      if (!src || !target) continue;
      if (!fs.existsSync(path.join(iconsFolder, `folder_${target}.svg`))) {
        console.log(
          `${C.yellow}  foldersReplacements ${rawSrc} -> ${rawTarget}: missing folder_${target}.svg in ${folderName}, skipped${C.nc}`,
        );
        continue;
      }
      const srcFolder = `folder_${src}`;
      const targetFolder = `folder_${target}`;
      const srcExpanded = `${srcFolder}_open`;
      const targetExpanded = `${targetFolder}_open`;
      for (const [k, v] of Object.entries(folderNames)) {
        if (v === srcFolder) folderNames[k] = targetFolder;
      }
      for (const [k, v] of Object.entries(folderNamesExpanded)) {
        if (v === srcExpanded) folderNamesExpanded[k] = targetExpanded;
      }
    }
  } else {
    return { fileSuffixes: {}, fileStems: {}, namedDirs: {} };
  }

  const fileSuffixes = addCaseVariations(fileExtensions);
  const fileStems = addCaseVariations(fileNames);

  const namedDirs = {};
  for (const [name, iconId] of Object.entries(folderNames)) {
    const expandedId = folderNamesExpanded[name] || `${iconId}_open`;
    if (fs.existsSync(path.join(iconsFolder, `${iconId}.svg`))) {
      const entry = {
        collapsed: `./icons/${folderName}/${iconId}.svg`,
        expanded: `./icons/${folderName}/${expandedId}.svg`,
      };
      namedDirs[name] = entry;
      namedDirs[name.toLowerCase()] = entry;
      namedDirs[name.toUpperCase()] = entry;
      namedDirs[name.charAt(0).toUpperCase() + name.slice(1)] = entry;
    }
  }

  return { fileSuffixes, fileStems, namedDirs };
}

// Parse a Material-Icons-style association key (e.g. "*.tss", "tailwind.css",
// "src/index.js", "src/*.index") into { dir, pattern, isExt }.
function parseAssociationKey(key) {
  let dir = "";
  let pattern = key;
  if (pattern.includes("/")) {
    const idx = pattern.lastIndexOf("/");
    dir = pattern.slice(0, idx);
    pattern = pattern.slice(idx + 1);
  }
  let isExt = false;
  if (pattern.startsWith("**.")) {
    pattern = pattern.slice(3);
    isExt = true;
  } else if (pattern.startsWith("*.")) {
    pattern = pattern.slice(2);
    isExt = true;
  }
  const finalKey = dir ? `${dir}/${pattern}` : pattern;
  return { finalKey, isExt };
}

function applyConfigToTheme(theme, config, folderName, iconsFolder) {
  if (!config) return;

  // folderColor: rewrite the default directory icon to the chosen color.
  if (config.folderColor && typeof config.folderColor === "string") {
    const color = config.folderColor;
    const collapsedSvg = path.join(iconsFolder, `folder_${color}.svg`);
    const expandedSvg = path.join(iconsFolder, `folder_${color}_open.svg`);
    if (fs.existsSync(collapsedSvg) && fs.existsSync(expandedSvg)) {
      theme.directory_icons = {
        collapsed: `./icons/${folderName}/folder_${color}.svg`,
        expanded: `./icons/${folderName}/folder_${color}_open.svg`,
      };
    } else {
      console.log(
        `${C.yellow}  folderColor "${color}": SVG missing in ${folderName}, kept default${C.nc}`,
      );
    }
  }

  // specificFolders=false: drop per-name folder icons entirely.
  if (config.specificFolders === false) {
    theme.named_directory_icons = {};
  }

  // filesAssociations: add/replace/remove entries in file_suffixes / file_stems.
  for (const [key, rawValue] of Object.entries(
    config.filesAssociations || {},
  )) {
    if (!key) continue;
    const target = normalizeIconName(String(rawValue));
    const { finalKey, isExt } = parseAssociationKey(key);
    const bucket = isExt ? theme.file_suffixes : theme.file_stems;
    if (!target) {
      delete bucket[finalKey];
      continue;
    }
    bucket[finalKey] = target;
  }

  // foldersAssociations: add/replace/remove entries in named_directory_icons.
  if (theme.named_directory_icons) {
    for (const [key, rawValue] of Object.entries(
      config.foldersAssociations || {},
    )) {
      if (!key) continue;
      const target = normalizeIconName(String(rawValue));
      if (!target) {
        delete theme.named_directory_icons[key];
        continue;
      }
      const collapsedId = `folder_${target}`;
      const expandedId = `${collapsedId}_open`;
      if (!fs.existsSync(path.join(iconsFolder, `${collapsedId}.svg`))) {
        console.log(
          `${C.yellow}  foldersAssociations ${key} -> ${rawValue}: missing ${collapsedId}.svg in ${folderName}, skipped${C.nc}`,
        );
        continue;
      }
      theme.named_directory_icons[key] = {
        collapsed: `./icons/${folderName}/${collapsedId}.svg`,
        expanded: `./icons/${folderName}/${expandedId}.svg`,
      };
    }
  }
}

function buildFlowIconsJson(config) {
  fs.mkdirSync(THEME_DIR, { recursive: true });

  const palettes = [
    { folder: "deep", name: "Flow Deep", appearance: "dark" },
    {
      folder: "deep-light",
      name: "Flow Deep (Light)",
      appearance: "light",
      themeJson: "deep",
    },
    { folder: "dim", name: "Flow Dim", appearance: "dark" },
    {
      folder: "dim-light",
      name: "Flow Dim (Light)",
      appearance: "light",
      themeJson: "dim",
    },
    { folder: "dawn", name: "Flow Dawn", appearance: "dark" },
    {
      folder: "dawn-light",
      name: "Flow Dawn (Light)",
      appearance: "light",
      themeJson: "dawn",
    },
    { folder: "you", name: "Flow You", appearance: "dark" },
    {
      folder: "you-light",
      name: "Flow You (Light)",
      appearance: "light",
      themeJson: "you",
    },
  ];

  const packContext = {
    iconsManifest: readJsonIfExists(ICONS_MANIFEST),
    defineManifest: readJsonIfExists(DEFINE_MANIFEST) || {
      files: {},
      folders: {},
    },
    packSettings: readJsonIfExists(PACK_SETTINGS_FILE) || DEFAULT_PACK_SETTINGS,
    explicitPacks: config?.activeIconPack || {},
    warnings: new Set(),
  };
  packContext.active = resolveActiveIconPacks(config, packContext.packSettings);

  const themes = [];
  for (const { folder, name, appearance, themeJson } of palettes) {
    const iconsFolder = path.join(ICONS_DIR, folder);
    const vscodeJson = path.join(ICONS_DIR, `${themeJson || folder}.json`);

    if (!fs.existsSync(iconsFolder)) continue;

    const { fileSuffixes, fileStems, namedDirs } = buildThemeFromVscodeJson(
      vscodeJson,
      folder,
      iconsFolder,
      config,
      packContext,
    );

    const theme = {
      name,
      appearance,
      directory_icons: {
        collapsed: `./icons/${folder}/folder_gray.svg`,
        expanded: `./icons/${folder}/folder_gray_open.svg`,
      },
      file_icons: buildFileIcons(iconsFolder, folder),
      file_suffixes: fileSuffixes,
      file_stems: fileStems,
      named_directory_icons: namedDirs,
    };

    applyConfigToTheme(theme, config, folder, iconsFolder);

    themes.push(theme);
  }

  for (const message of packContext.warnings) {
    console.log(`${C.yellow}  ${message}${C.nc}`);
  }

  const zedTheme = {
    $schema: "https://zed.dev/schema/icon_themes/v0.3.0.json",
    name: "Flow Icons",
    author: "thang-nm",
    themes,
  };

  const outputPath = path.join(THEME_DIR, "flow-icons.json");
  fs.writeFileSync(outputPath, JSON.stringify(zedTheme, null, 2));
  return outputPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const licenseKey = process.argv[2] || process.env.FLOW_ICONS_LICENSE;
  const machineId = getMachineId();

  console.log(`${C.green}Flow Icons Updater for Zed${C.nc}`);
  console.log("=".repeat(32));
  console.log();

  if (!licenseKey) {
    console.log(`No license key — downloading demo icons from Open VSX.`);
    console.log(
      `${C.yellow}Tip: Provide a license key for premium icons.${C.nc}`,
    );
    console.log();
  }

  // Step 1: Fetch extension version from Open VSX
  process.stdout.write("Fetching extension info... ");
  let extensionVersion, vsixUrl;
  try {
    const info = await getExtensionInfo();
    extensionVersion = info.version;
    vsixUrl = info.vsixUrl;
    console.log(`${C.green}OK${C.nc} (v${extensionVersion})`);
  } catch (e) {
    console.log(`${C.red}Failed${C.nc}`);
    console.log(`Error: ${e.message}`);
    process.exit(1);
  }

  // If the source VS Code theme JSONs or the Flow You templates aren't on
  // disk, we can't rebuild without re-downloading - older versions of this
  // script didn't fetch them. Drop the recorded version so the normal
  // version-mismatch path triggers a refresh.
  const sourceJsonsExist = [
    "deep.json",
    "dim.json",
    "dawn.json",
    "you.json",
  ].every((f) => fs.existsSync(path.join(ICONS_DIR, f)));
  const templatesExist = fs.existsSync(FLOW_YOU_TEMPLATE_DIR);
  if ((!sourceJsonsExist || !templatesExist) && fs.existsSync(VERSION_FILE)) {
    fs.rmSync(VERSION_FILE, { force: true });
  }

  const currentVersion = getCurrentVersion();
  let remoteVersion;
  let downloadSuccess = false;

  if (licenseKey) {
    // --- Premium flow: use licensed API ---
    process.stdout.write("Checking for premium updates... ");
    let downloadUrl;
    try {
      const versionInfo = await getLatestVersion(
        licenseKey,
        machineId,
        extensionVersion,
      );
      remoteVersion = `${extensionVersion}-${versionInfo.version}`;
      downloadUrl = versionInfo.url;
      console.log(`${C.green}OK${C.nc} (icons v${versionInfo.version})`);
    } catch (e) {
      console.log(`${C.red}Failed${C.nc}`);
      console.log(`Error: ${e.message}`);
      process.exit(1);
    }

    if (currentVersion === remoteVersion) {
      console.log(
        `${C.green}Icons up to date, rebuilding theme from existing icons${C.nc}`,
      );
    } else {
      process.stdout.write("Downloading premium icons... ");
      try {
        const compressedData = await download(downloadUrl);
        const sizeMb = (compressedData.length / (1024 * 1024)).toFixed(1);
        console.log(`${C.green}OK${C.nc} (${sizeMb}M)`);

        process.stdout.write("Extracting icons... ");
        fs.rmSync(ICONS_DIR, { recursive: true, force: true });
        fs.mkdirSync(ICONS_DIR, { recursive: true });
        extractIcons(compressedData, ICONS_DIR);
        console.log(`${C.green}OK${C.nc}`);
        downloadSuccess = true;
      } catch (e) {
        console.log(`${C.red}Failed${C.nc}`);
        console.log(`Error: ${e.message}`);
        if (!fs.existsSync(path.join(ICONS_DIR, "deep"))) {
          process.exit(1);
        }
        console.log("  Using existing icons...");
      }
    }
  } else {
    // --- Demo flow: download VSIX from Open VSX ---
    remoteVersion = extensionVersion;

    if (currentVersion === remoteVersion) {
      console.log(
        `${C.green}Icons up to date, rebuilding theme from existing icons${C.nc}`,
      );
    } else {
      process.stdout.write("Downloading VSIX... ");
      try {
        const vsixData = await download(vsixUrl);
        const sizeMb = (vsixData.length / (1024 * 1024)).toFixed(1);
        console.log(`${C.green}OK${C.nc} (${sizeMb}M)`);

        process.stdout.write("Extracting icons... ");
        fs.rmSync(ICONS_DIR, { recursive: true, force: true });
        fs.mkdirSync(ICONS_DIR, { recursive: true });
        // Note: the VSIX also ships pre-built `you/` and `you-light/`
        // folders, but we generate those locally from `icons/` so the user
        // can customize the Flow You palette via `config.json`.
        const iconDirs = [
          "deep/",
          "deep-light/",
          "dim/",
          "dim-light/",
          "dawn/",
          "dawn-light/",
          "icons/",
        ];
        const themeJsons = ["deep.json", "dim.json", "dawn.json", "you.json"];
        const manifestJsons = ["icons.json", "define.json", "settings.json"];
        extractZip(
          vsixData,
          ICONS_DIR,
          "extension/",
          (name) =>
            iconDirs.some((d) => name.startsWith(d)) ||
            themeJsons.includes(name) ||
            manifestJsons.includes(name),
        );
        console.log(`${C.green}OK${C.nc}`);
        downloadSuccess = true;
      } catch (e) {
        console.log(`${C.red}Failed${C.nc}`);
        console.log(`Error: ${e.message}`);
        if (!fs.existsSync(path.join(ICONS_DIR, "deep"))) {
          process.exit(1);
        }
        console.log("  Using existing icons...");
      }
    }
  }

  // Load config once and pass it to both the Flow You builder and the
  // theme builder so we don't double-log "Loaded config.json".
  const config = loadConfig();
  if (config) {
    console.log(`${C.green}Loaded config.json${C.nc}`);
  }

  // Generate Flow You SVGs from the templates using the user's palette (or
  // the default monochromatic slate when no `youColors` is configured).
  process.stdout.write("Building Flow You icons... ");
  try {
    buildYouIcons(config?.youColors);
    console.log(`${C.green}OK${C.nc}`);
  } catch (e) {
    console.log(`${C.red}Failed${C.nc}`);
    console.log(`Error: ${e.message}`);
    process.exit(1);
  }

  // Build theme JSON
  process.stdout.write("Building theme... ");
  let themePath;
  try {
    themePath = buildFlowIconsJson(config);
    // Clean up anything that isn't an icon folder or a VS Code source theme
    // JSON. The source theme JSONs and the Flow You template folder are
    // kept so subsequent runs can rebuild from a changed config.json
    // without re-downloading.
    const keepEntries = new Set([
      "deep",
      "deep-light",
      "dim",
      "dim-light",
      "dawn",
      "dawn-light",
      "you",
      "you-light",
      "icons",
      "deep.json",
      "dim.json",
      "dawn.json",
      "you.json",
      "icons.json",
      "define.json",
      "settings.json",
    ]);
    for (const entry of fs.readdirSync(ICONS_DIR)) {
      if (!keepEntries.has(entry)) {
        const p = path.join(ICONS_DIR, entry);
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {}
      }
    }
    console.log(`${C.green}OK${C.nc}`);
  } catch (e) {
    console.log(`${C.red}Failed${C.nc}`);
    console.log(`Error: ${e.message}`);
    process.exit(1);
  }

  saveVersion(remoteVersion);

  console.log();
  console.log(`${C.green}Success!${C.nc}`);
  for (const folder of [
    "deep",
    "deep-light",
    "dim",
    "dim-light",
    "dawn",
    "dawn-light",
    "you",
    "you-light",
  ]) {
    const count = countIcons(folder);
    console.log(`  ${folder.padEnd(12)} ${count} icons`);
  }
  console.log(`  Theme file:  ${themePath}`);
  console.log();
  console.log(`${C.yellow}Restart Zed to see the updated icons.${C.nc}`);
}

module.exports = { buildFlowIconsJson, loadConfig };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`${C.red}Unexpected error: ${e.message}${C.nc}`);
      process.exit(1);
    },
  );
}

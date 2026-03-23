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
// Helpers
// ---------------------------------------------------------------------------

function getMachineId() {
  return crypto.createHash("md5").update(os.hostname()).digest("hex");
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
      .filter((f) => f.endsWith(".png") && !f.startsWith("._")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Theme builder
// ---------------------------------------------------------------------------

function buildFileIcons(iconsFolder, folderName) {
  const fileIcons = { default: { path: `./icons/${folderName}/file.png` } };
  for (const file of fs.readdirSync(iconsFolder).sort()) {
    if (!file.endsWith(".png") || file.startsWith("._")) continue;
    const iconId = path.parse(file).name;
    if (iconId.startsWith("folder_")) continue;
    fileIcons[iconId] = { path: `./icons/${folderName}/${iconId}.png` };
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

function buildThemeFromVscodeJson(vscodeThemePath, folderName, iconsFolder) {
  if (!fs.existsSync(vscodeThemePath)) {
    return { fileSuffixes: {}, fileStems: {}, namedDirs: {} };
  }

  const vscodeTheme = JSON.parse(fs.readFileSync(vscodeThemePath, "utf8"));
  const fileSuffixes = addCaseVariations(vscodeTheme.fileExtensions || {});
  const fileStems = addCaseVariations(vscodeTheme.fileNames || {});

  const folderNames = vscodeTheme.folderNames || {};
  const folderNamesExpanded = vscodeTheme.folderNamesExpanded || {};

  const namedDirs = {};
  for (const [name, iconId] of Object.entries(folderNames)) {
    const expandedId = folderNamesExpanded[name] || `${iconId}_open`;
    if (fs.existsSync(path.join(iconsFolder, `${iconId}.png`))) {
      const entry = {
        collapsed: `./icons/${folderName}/${iconId}.png`,
        expanded: `./icons/${folderName}/${expandedId}.png`,
      };
      namedDirs[name] = entry;
      namedDirs[name.toLowerCase()] = entry;
      namedDirs[name.toUpperCase()] = entry;
      namedDirs[name.charAt(0).toUpperCase() + name.slice(1)] = entry;
    }
  }

  return { fileSuffixes, fileStems, namedDirs };
}

function buildFlowIconsJson() {
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
  ];

  const themes = [];
  for (const { folder, name, appearance, themeJson } of palettes) {
    const iconsFolder = path.join(ICONS_DIR, folder);
    const vscodeJson = path.join(ICONS_DIR, `${themeJson || folder}.json`);

    if (!fs.existsSync(iconsFolder)) continue;

    const { fileSuffixes, fileStems, namedDirs } = buildThemeFromVscodeJson(
      vscodeJson,
      folder,
      iconsFolder,
    );

    themes.push({
      name,
      appearance,
      directory_icons: {
        collapsed: `./icons/${folder}/folder_gray.png`,
        expanded: `./icons/${folder}/folder_gray_open.png`,
      },
      file_icons: buildFileIcons(iconsFolder, folder),
      file_suffixes: fileSuffixes,
      file_stems: fileStems,
      named_directory_icons: namedDirs,
    });
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
      console.log(`${C.green}Already up to date!${C.nc}`);
      return;
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
      console.log(`${C.green}Already up to date!${C.nc}`);
      return;
    } else {
      process.stdout.write("Downloading VSIX... ");
      try {
        const vsixData = await download(vsixUrl);
        const sizeMb = (vsixData.length / (1024 * 1024)).toFixed(1);
        console.log(`${C.green}OK${C.nc} (${sizeMb}M)`);

        process.stdout.write("Extracting icons... ");
        fs.rmSync(ICONS_DIR, { recursive: true, force: true });
        fs.mkdirSync(ICONS_DIR, { recursive: true });
        const iconDirs = [
          "deep/",
          "deep-light/",
          "dim/",
          "dim-light/",
          "dawn/",
          "dawn-light/",
        ];
        const themeJsons = ["deep.json", "dim.json", "dawn.json"];
        extractZip(
          vsixData,
          ICONS_DIR,
          "extension/",
          (name) =>
            iconDirs.some((d) => name.startsWith(d)) ||
            themeJsons.includes(name),
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

  // Build theme JSON
  process.stdout.write("Building theme... ");
  let themePath;
  try {
    themePath = buildFlowIconsJson();
    // Clean up anything that isn't an icon folder or theme JSON
    const keepEntries = new Set([
      "deep",
      "deep-light",
      "dim",
      "dim-light",
      "dawn",
      "dawn-light",
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
  ]) {
    const count = countIcons(folder);
    console.log(`  ${folder.padEnd(12)} ${count} icons`);
  }
  console.log(`  Theme file:  ${themePath}`);
  console.log();
  console.log(`${C.yellow}Restart Zed to see the updated icons.${C.nc}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`${C.red}Unexpected error: ${e.message}${C.nc}`);
    process.exit(1);
  },
);

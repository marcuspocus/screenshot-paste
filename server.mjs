#!/usr/bin/env node
/**
 * Standalone screenshot-paste HTTP server for development.
 *
 * Usage:  node server.mjs [--port 9876]
 *
 * The pi extension (.pi/extensions/screenshot-paste/index.ts) starts this
 * server automatically via Node's http module. This script is for manual
 * dev / debugging when you need to run the server outside of pi.
 */

import { createServer } from "node:http";
import { mkdirSync, existsSync, readdirSync, unlinkSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.PI_PASTE_PORT ?? process.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? "9876", 10);

// ── access log ────────────────────────────────────────────────────────────

function accessLog(req, res, startTime) {
  const method = req.method ?? "-";
  const url = req.url ?? "-";
  const status = res.statusCode ?? 0;
  const duration = Date.now() - startTime;
  console.log(`[screenshot-paste] ${method} ${url} ${status} ${duration}ms`);
}

// ── helpers ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── handlers ───────────────────────────────────────────────────────────────

async function handleUpload(req, res) {
  const body = JSON.parse(await readBody(req));
  const { base64: b64, filename = "paste.png", workspace } = body;
  if (typeof workspace !== "string" || workspace.length === 0) {
    json(res, { error: "Workspace path is required. Images must be saved to workspace/.pi-paste/ for remote agents." }, 400);
    return;
  }
  const saveDir = ensureDir(join(workspace, ".pi-paste"));
  const filePath = join(saveDir, filename);
  const imageBytes = Buffer.from(b64, "base64");
  writeFileSync(filePath, imageBytes);
  const relativePath = `.pi-paste/${filename}`;
  json(res, { path: filePath, relativePath, filename, size: imageBytes.length });
}

function handleImages(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const workspace = url.searchParams.get("workspace");
  if (!workspace) { json(res, []); return; }
  const d = join(workspace, ".pi-paste");
  const images = [];
  if (existsSync(d)) {
    for (const f of readdirSync(d).sort()) {
      const full = join(d, f);
      if (statSync(full).isFile()) images.push({ filename: f, path: full, size: statSync(full).size });
    }
  }
  json(res, images);
}

function handleServeImage(req, res, filename) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const workspace = url.searchParams.get("workspace");
  if (!workspace) { json(res, { error: "Workspace path is required" }, 400); return; }

  const filePath = join(workspace, ".pi-paste", filename);
  if (!filePath) { json(res, { error: "Not found" }, 404); return; }
  const ext = extname(filePath).toLowerCase();
  const ct = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : "application/octet-stream";
  const data = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": ct, "Content-Length": data.length });
  res.end(data);
}

function handleClean(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const workspace = url.searchParams.get("workspace");
  if (!workspace) { json(res, { error: "Workspace path is required" }, 400); return; }
  const d = join(workspace, ".pi-paste");
  let deleted = 0;
  if (existsSync(d)) {
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      try { if (statSync(full).isFile()) { unlinkSync(full); deleted++; } } catch {}
    }
  }
  json(res, { deleted });
}

// ── server ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const startTime = Date.now();
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); accessLog(req, res, startTime); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/upload") await handleUpload(req, res);
    else if (req.method === "GET" && url.pathname === "/images") handleImages(req, res);
    else if (req.method === "GET" && url.pathname.startsWith("/images/")) handleServeImage(req, res, url.pathname.split("/").pop());
    else if (req.method === "GET" && url.pathname === "/health") json(res, { status: "ok" });
    else if (req.method === "DELETE" && url.pathname === "/clean") handleClean(req, res);
    else json(res, { error: "Not found" }, 404);
  } catch (err) { console.error("[screenshot-paste]", err); json(res, { error: String(err) }, 500); }
  finally { accessLog(req, res, startTime); }
});

server.listen(PORT, () => {
  console.log(`🖼️  Screenshot paste server running at http://localhost:${PORT}`);
  console.log("📁 Upload directory: workspace/.pi-paste (workspace required)");
});
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

const PORT = 9876;
let server: ReturnType<typeof createServer> | null = null;

// ── helpers ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── access log ────────────────────────────────────────────────────────────

function accessLog(req: IncomingMessage, res: ServerResponse, startTime: number) {
  const method = req.method ?? "-";
  const url = req.url ?? "-";
  const status = res.statusCode ?? 0;
  const duration = Date.now() - startTime;
  console.log(`[screenshot-paste] ${method} ${url} ${status} ${duration}ms`);
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const body = JSON.parse(await readBody(req));
  const { base64: b64, filename = "paste.png", workspace } = body as {
    base64: string;
    filename?: string;
    workspace?: string;
  };

  const saveDir = workspace
    ? ensureDir(join(workspace, ".pi-paste"))
    : ensureDir(join(homedir(), ".pi-paste"));
  const filePath = join(saveDir, filename);

  const imageBytes = Buffer.from(b64, "base64");
  writeFileSync(filePath, imageBytes);

  const relativePath = workspace ? `.pi-paste/${filename}` : filePath;
  json(res, {
    path: filePath,
    relativePath,
    filename,
    size: imageBytes.length,
  });
}

function handleImages(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const workspace = url.searchParams.get("workspace");

  const dirs = [join(homedir(), ".pi-paste")];
  if (workspace) dirs.push(join(workspace, ".pi-paste"));

  const images: Array<{
    filename: string;
    path: string;
    size: number;
  }> = [];

  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      const full = join(d, f);
      if (statSync(full).isFile()) {
        images.push({
          filename: f,
          path: full,
          size: statSync(full).size,
        });
      }
    }
  }
  json(res, images);
}

function handleServeImage(
  req: IncomingMessage,
  res: ServerResponse,
  filename: string,
) {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const workspace = url.searchParams.get("workspace");

  const dirs = [join(homedir(), ".pi-paste")];
  if (workspace) dirs.push(join(workspace, ".pi-paste"));

  let filePath: string | null = null;
  for (const d of dirs) {
    const candidate = join(d, filename);
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }
  if (!filePath) {
    json(res, { error: "Not found" }, 404);
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const ct =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
        ? "image/png"
        : "application/octet-stream";

  const data = require("node:fs").readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": ct,
    "Content-Length": data.length,
  });
  res.end(data);
}

function handleClean(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const workspace = url.searchParams.get("workspace");

  const dirs = [join(homedir(), ".pi-paste")];
  if (workspace) dirs.push(join(workspace, ".pi-paste"));

  let deleted = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      try {
        if (statSync(full).isFile()) {
          unlinkSync(full);
          deleted++;
        }
      } catch { /* best effort */ }
    }
  }
  json(res, { deleted });
}

// ── server lifecycle ───────────────────────────────────────────────────────

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      const startTime = Date.now();
      cors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        accessLog(req, res, startTime);
        return;
      }

      const url = new URL(req.url!, `http://localhost:${PORT}`);
      try {
        if (req.method === "POST" && url.pathname === "/upload") {
          await handleUpload(req, res);
        } else if (req.method === "GET" && url.pathname === "/images") {
          handleImages(req, res);
        } else if (
          req.method === "GET" &&
          url.pathname.startsWith("/images/")
        ) {
          handleServeImage(req, res, url.pathname.split("/").pop()!);
        } else if (req.method === "GET" && url.pathname === "/health") {
          json(res, { status: "ok" });
        } else if (req.method === "DELETE" && url.pathname === "/clean") {
          handleClean(req, res);
        } else {
          json(res, { error: "Not found" }, 404);
        }
      } catch (err) {
        console.error("[screenshot-paste] Request error:", err);
        json(res, { error: String(err) }, 500);
      } finally {
        accessLog(req, res, startTime);
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.log(
          `[screenshot-paste] Port ${PORT} already in use — server already running`,
        );
        server = null;
        resolve();
      } else {
        reject(err);
      }
    });

    server.listen(PORT, () => {
      console.log(
        `[screenshot-paste] Server running at http://localhost:${PORT}`,
      );
      resolve();
    });
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}

// ── extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      // Check if already running
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) {
        ctx.ui.notify(
          `[screenshot-paste] Server already running on port ${PORT}`,
          "info",
        );
        return;
      }
    } catch {
      /* not running — start it */
    }

    try {
      await startServer();
      ctx.ui.notify(
        `[screenshot-paste] Server started on port ${PORT}`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(
        `[screenshot-paste] Failed to start server: ${err}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    stopServer();
  });

  pi.registerCommand("paste-server", {
    description: "Check screenshot paste server status",
    handler: async (_args, ctx) => {
      try {
        const res = await fetch(`http://localhost:${PORT}/health`);
        const data = await res.json();
        ctx.ui.notify(`Screenshot paste server: ${JSON.stringify(data)}`, "info");
      } catch {
        ctx.ui.notify(
          "Screenshot paste server is not running. Restart pi to start it.",
          "error",
        );
      }
    },
  });
}
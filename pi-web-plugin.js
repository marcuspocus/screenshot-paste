// @screenshot-paste v0.4.0 — Hybrid native input + gallery mode
//
// Observes pasted images while letting pi-web's native PromptEditor handle the
// actual paste. This preserves native inline thumbnails, remove buttons, and the
// attachment delivery dropdown in the chat input.
//
// In parallel, the plugin saves a processed copy into `.pi-web/paste/` so the
// workspace gallery/lightbox has an immediate on-disk history of screenshots.
//
// What remains pi-web native: image paste UI, non-image paste, text paste,
// file drag/drop, and final attachment delivery on send.
//
// What this plugin adds on top of native paste:
//   1. Navigable gallery of `.pi-web/paste/` (workspace panel).
//   2. Fullscreen lightbox viewer.
//   3. Inline <img> previews inside chat user messages for `@.pi-web/paste/...` refs
//      (folder-mode refs are text-only in pi-web ChatView).
//   4. "Clean" action deleting `.pi-web/paste/` contents.
//   5. Idempotent gitignore of `.pi-web/paste/` (pi-web does not manage gitignore).
//
// Uses stable pi-web plugin APIs:
//   - context.files.writeFile / readFile / deleteFile  (federated, auto-refresh)
//
// @private-api: prompt editor DOM detection and chat DOM walk
// (injectChatThumbnails) are the only remaining private-API surfaces.

const PLUGIN_VERSION = "0.4.0-dev";
const PASTE_DIR = ".pi-web/paste";
const GITIGNORE_ENTRY = ".pi-web/paste/";
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp)$/iu;
const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;
const MAX_BASE64_LENGTH = 5_000_000;
const SHADOW_DEPTH_LIMIT = 3;

// ── state ──────────────────────────────────────────────────────────────────
let handlePaste = null; // global paste listener
let cachedPromptEditor = null;
let activeKeyHandler = null;

// Bridge: holds the latest files API + workspace + machine from any context callback.
// Updated by workspace panel/label callbacks (they carry files + workspace + machine).
let bridgeFiles = null; // captured from panel badge (has writeFile)
let bridgeRuntime = null; // captured from panel or label
let bridgeWorkspace = null; // captured from panel or label
let bridgeMachine = null; // captured from panel or label

const galleryCacheByWorkspace = new Map(); // key -> { images, fetchedAt, promise }
const GALLERY_CACHE_TTL_MS = 5000;
const gitignoredWorkspaces = new Set();

// Chat thumbnail observer
const CHAT_POLL_INTERVAL_MS = 3000;
let chatObserver = null;
let chatPoll = null;
let chatDirty = true;
let cachedChatRoot = null;
let fileApiStatus = "initializing";
let fileApiStatusDetail = "Waiting for workspace files API";

// Prompt composer staged previews for images inserted as @.pi-web/paste/... refs.
const promptPreviewImages = new Map(); // filePath -> image metadata

// ── runtime helpers ────────────────────────────────────────────────────────
function runtimeKey(rt) {
  return rt ? `${rt.machineId}:${rt.projectId}:${rt.workspaceId}` : "unknown";
}

function updateRuntime(context) {
  const workspace = context?.workspace ?? context?.state?.selectedWorkspace ?? null;
  const machine = context?.machine ?? { id: "local", name: "local", kind: "local" };
  if (!workspace?.id || !workspace?.projectId) return null;
  return {
    machineId: machine.id ?? "local",
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  };
}

function captureFilesApi(context, source) {
  const rt = updateRuntime(context);
  if (!rt) {
    fileApiStatus = "error";
    fileApiStatusDetail = "No active workspace runtime";
    return false;
  }

  bridgeRuntime = rt;
  bridgeWorkspace = context.workspace ?? bridgeWorkspace;
  bridgeMachine = context.machine ?? bridgeMachine ?? { id: "local" };

  const files = context?.files;
  if (!files || typeof files.readFile !== "function") {
    fileApiStatus = "initializing";
    fileApiStatusDetail = `Waiting for files API (${source}: ${Object.keys(files || {}).join(", ") || "none"})`;
    console.log("[screenshot-paste] files API not ready from", source, Object.keys(files || {}));
    return false;
  }

  const hasAnyMutation = typeof files.writeFile === "function" || typeof files.deleteFile === "function" || typeof files.moveFile === "function";
  if (!hasAnyMutation) {
    fileApiStatus = "error";
    fileApiStatusDetail = `Read-only files API (${source}: ${Object.keys(files).join(", ")}). Update pi-web/plugin API to expose writeFile/deleteFile.`;
    console.warn("[screenshot-paste] files API is read-only from", source, Object.keys(files));
    return false;
  }

  // Store stable wrappers instead of the raw context object. Some pi-web contexts are
  // scoped/proxied; wrappers keep the captured functions callable after render.
  bridgeFiles = {
    readFile: (path) => files.readFile(path),
    ...(typeof files.writeFile === "function" ? { writeFile: (path, content, options) => files.writeFile(path, content, options) } : {}),
    ...(typeof files.deleteFile === "function" ? { deleteFile: (path) => files.deleteFile(path) } : {}),
    ...(typeof files.moveFile === "function" ? { moveFile: (fromPath, toPath, options) => files.moveFile(fromPath, toPath, options) } : {}),
  };
  fileApiStatus = "initialized";
  fileApiStatusDetail = `Files API ready (${source}: ${Object.keys(bridgeFiles).join(", ")})`;
  console.log("[screenshot-paste] files API initialized from", source, Object.keys(bridgeFiles), runtimeKey(rt));
  return true;
}

function updateBridgeFromPanel(context) {
  captureFilesApi(context, "panel");
}

function updateBridgeFromLabel(context) {
  captureFilesApi(context, "label");
}

function getRuntimeFromPiWebApp() {
  try {
    const app = document.querySelector('pi-web-app');
    if (!app) return null;
    const state = app.state ?? app['state'];
    if (!state) return null;
    const workspace = state.selectedWorkspace;
    const machine = state.selectedMachine;
    if (!workspace?.id || !workspace?.projectId) return null;
    return {
      machineId: machine?.id ?? 'local',
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
    };
  } catch {
    return null;
  }
}

function getRuntime() {
  if (bridgeRuntime) return bridgeRuntime;
  return getRuntimeFromPiWebApp();
}

function getMachine() {
  if (bridgeMachine) return bridgeMachine;
  try {
    const app = document.querySelector('pi-web-app');
    const state = app?.state ?? app?.['state'];
    return state?.selectedMachine ?? { id: 'local' };
  } catch {
    return { id: 'local' };
  }
}

function getWorkspace() {
  if (bridgeWorkspace) return bridgeWorkspace;
  try {
    const app = document.querySelector('pi-web-app');
    const state = app?.state ?? app?.['state'];
    return state?.selectedWorkspace ?? null;
  } catch {
    return null;
  }
}

function getPromptEditorContext() {
  try {
    const editor = querySelectorDeep('prompt-editor');
    return {
      sessionId: editor?.sessionId ?? null,
      cwd: editor?.cwd ?? null,
      machineId: editor?.machineId ?? null,
      attachmentDelivery: editor?.attachmentDelivery ?? null,
    };
  } catch {
    return { sessionId: null, cwd: null, machineId: null, attachmentDelivery: null };
  }
}

function getSessionId() {
  try {
    const prompt = getPromptEditorContext();
    if (prompt.sessionId) return prompt.sessionId;
    const app = document.querySelector('pi-web-app');
    const state = app?.state ?? app?.['state'];
    return state?.selectedSession?.id ?? null;
  } catch {
    return null;
  }
}

function getFiles() {
  if (bridgeFiles) return bridgeFiles;
  throw new Error("Gallery file API not initialized yet. Reopen the Paste panel, then try again.");
}

async function saveAttachmentViaSession(sessionId, base64, mimeType, filename) {
  const runtime = getRuntime();
  const prompt = getPromptEditorContext();
  const machineId = prompt.machineId ?? runtime?.machineId ?? 'local';
  const cwd = prompt.cwd ?? runtime?.workspacePath;
  if (!cwd) throw new Error("No active workspace cwd available");
  const prefix = machineId === 'local' ? '/api' : `/api/machines/${encodeURIComponent(machineId)}`;
  const url = `${prefix}/sessions/${encodeURIComponent(sessionId)}/attachments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd,
      attachments: [{
        kind: 'image',
        mimeType,
        data: base64,
        name: filename,
      }],
      folder: '.pi-web/paste',
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || response.statusText);
  }
  const result = await response.json();
  return result.attachments?.[0];
}

// ── preview URL ────────────────────────────────────────────────────────────
function workspaceApiBase(rt) {
  if (!rt?.machineId || !rt?.projectId || !rt?.workspaceId) return null;
  return `/api/machines/${encodeURIComponent(rt.machineId)}`
    + `/projects/${encodeURIComponent(rt.projectId)}`
    + `/workspaces/${encodeURIComponent(rt.workspaceId)}`;
}

function previewUrl(filePath, rt, version = Date.now()) {
  const base = workspaceApiBase(rt);
  if (!base) return "";
  const params = new URLSearchParams({ path: filePath, v: String(version) });
  return `${base}/file/preview?${params.toString()}`;
}

async function deleteWorkspaceFile(filePath) {
  const files = getFiles();
  if (typeof files.deleteFile !== "function") {
    throw new Error("Gallery delete requires context.files.deleteFile, but pi-web exposed a read-only files API.");
  }
  return files.deleteFile(filePath);
}

// ── deep DOM query (pierces shadow roots) — minimal ────────────────────────
function querySelectorDeep(selector, root = document, depth = 0) {
  const found = root.querySelector(selector);
  if (found) return found;
  if (depth >= SHADOW_DEPTH_LIMIT) return null;
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const result = querySelectorDeep(selector, el.shadowRoot, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

function querySelectorAllDeep(selector, root = document, depth = 0) {
  const results = [];
  function search(node, d) {
    results.push(...node.querySelectorAll(selector));
    if (d >= SHADOW_DEPTH_LIMIT) return;
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) search(el.shadowRoot, d + 1);
    }
  }
  search(root, depth);
  return results;
}

// ── prompt editor DOM access (@private-api) ────────────────────────────────
function getPromptEditor() {
  try {
    if (cachedPromptEditor?.isConnected) return cachedPromptEditor;
    cachedPromptEditor = querySelectorDeep("prompt-editor");
    return cachedPromptEditor;
  } catch { return null; }
}

function insertTextAtCursor(text) {
  try {
    const view = getPromptEditor()?.editor;
    if (!view) return false;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    view.focus();
    return true;
  } catch { return false; }
}

function promptText() {
  try {
    return getPromptEditor()?.editor?.state?.doc?.toString?.() ?? "";
  } catch {
    return "";
  }
}

function removeTextFromPrompt(filePath) {
  try {
    const view = getPromptEditor()?.editor;
    if (!view) return false;
    const doc = view.state.doc.toString();
    const candidates = [`@${filePath} `, `@${filePath}`, `${filePath} `, filePath];
    for (const text of candidates) {
      const from = doc.indexOf(text);
      if (from === -1) continue;
      view.dispatch({ changes: { from, to: from + text.length, insert: "" } });
      view.focus();
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function prunePromptPreviews() {
  const text = promptText();
  for (const filePath of [...promptPreviewImages.keys()]) {
    if (!text.includes(filePath)) promptPreviewImages.delete(filePath);
  }
}

function renderPromptPreviews() {
  prunePromptPreviews();
  const editor = getPromptEditor();
  const root = editor?.shadowRoot;
  const wrap = root?.querySelector?.(".editor-wrap");
  if (!wrap) return;

  let strip = root.querySelector(".screenshot-paste-prompt-strip");
  if (promptPreviewImages.size === 0) {
    strip?.remove();
    return;
  }

  if (!strip) {
    strip = document.createElement("div");
    strip.className = "screenshot-paste-prompt-strip";
    strip.style.cssText = [
      "display:flex", "gap:8px", "flex-wrap:wrap", "align-items:center",
      "padding:8px", "margin:0 0 6px 0",
      "border:1px solid var(--pi-border,#30363d)", "border-radius:8px",
      "background:var(--pi-surface,#0d1117)",
    ].join(";");
    const anchor = wrap.querySelector(".markdown-editor");
    wrap.insertBefore(strip, anchor ?? wrap.firstChild);
  }

  strip.innerHTML = "";
  for (const image of promptPreviewImages.values()) {
    const card = document.createElement("div");
    card.style.cssText = [
      "position:relative", "width:96px", "height:96px", "flex:0 0 auto",
      "border-radius:8px", "overflow:hidden",
      "border:1px solid var(--pi-border,#30363d)",
      "background:var(--pi-border,#30363d)", "cursor:pointer",
    ].join(";");

    const img = document.createElement("img");
    img.src = image.serverUrl;
    img.alt = image.filename ?? image.filePath;
    img.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
    card.appendChild(img);
    card.onclick = () => showLightbox([...promptPreviewImages.values()], [...promptPreviewImages.keys()].indexOf(image.filePath));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove screenshot";
    remove.setAttribute("aria-label", "Remove screenshot");
    remove.style.cssText = [
      "position:absolute", "top:4px", "right:4px", "width:22px", "height:22px",
      "border-radius:999px", "border:1px solid rgba(255,255,255,.35)",
      "background:rgba(0,0,0,.72)", "color:white", "font-size:16px", "line-height:18px",
      "cursor:pointer", "padding:0",
    ].join(";");
    remove.onclick = (event) => {
      event.stopPropagation();
      promptPreviewImages.delete(image.filePath);
      removeTextFromPrompt(image.filePath);
      renderPromptPreviews();
    };
    card.appendChild(remove);
    strip.appendChild(card);
  }
}

function isPasteInPromptEditor(event) {
  return event.composedPath().some((el) => el?.localName === "prompt-editor" || el?.tagName === "PROMPT-EDITOR");
}

// ── image processing ─────────────────────────────────────────────────────────
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function processImage(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > MAX_DIM || h > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      canvas.toBlob(
        (pngBlob) => {
          if (!pngBlob) { resolve(null); return; }
          canvas.toBlob((jpgBlob) => {
            if (jpgBlob && jpgBlob.size < pngBlob.size * 0.75) {
              resolve({ blob: jpgBlob, mimeType: "image/jpeg", w, h });
            } else {
              resolve({ blob: pngBlob, mimeType: "image/png", w, h });
            }
          }, "image/jpeg", JPEG_QUALITY);
        },
        "image/png",
      );
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null); };
    img.src = URL.createObjectURL(blob);
  });
}

async function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

// ── write paste image to workspace via files API ───────────────────────────
async function writePasteImage(blob, processed) {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 6);
  const ext = processed.mimeType.split("/")[1] || "png";
  const filename = `paste-${ts}-${rnd}.${ext}`;
  const filePath = `${PASTE_DIR}/${filename}`;

  if (bridgeFiles && typeof bridgeFiles.writeFile === "function") {
    try {
      const arrayBuffer = await blobToArrayBuffer(processed.blob);
      const bytes = new Uint8Array(arrayBuffer);
      await bridgeFiles.writeFile(filePath, bytes, { createDirs: true, overwrite: true });
      await ensurePasteGitignored();
      return {
        filePath,
        filename,
        serverUrl: previewUrl(filePath, getRuntime(), ts),
        ts,
        w: processed.w,
        h: processed.h,
        size: processed.blob.size,
        mimeType: processed.mimeType,
      };
    } catch (error) {
      console.warn("[screenshot-paste] bridgeFiles.writeFile failed, trying session fallback", error);
    }
  }

  const sessionId = getSessionId();
  if (!sessionId) {
    throw new Error("No active pi session detected. Click/focus the chat composer once, then paste again.");
  }
  const base64 = await blobToBase64(processed.blob);
  const saved = await saveAttachmentViaSession(sessionId, base64, processed.mimeType, filename);
  if (!saved?.path) {
    throw new Error("Server did not return attachment path");
  }
  await ensurePasteGitignored();
  return {
    filePath: saved.path,
    filename: saved.path.split('/').pop(),
    serverUrl: previewUrl(saved.path, getRuntime(), ts),
    ts,
    w: processed.w,
    h: processed.h,
    size: processed.blob.size,
    mimeType: processed.mimeType,
  };
}

// ── idempotent gitignore of .pi-web/paste/ ─────────────────────────────────
async function ensurePasteGitignored() {
  const key = runtimeKey(getRuntime());
  if (gitignoredWorkspaces.has(key)) return;
  if (!bridgeFiles || typeof bridgeFiles.writeFile !== "function") return;

  let current = "";
  try {
    const content = await bridgeFiles.readFile(".gitignore");
    current = content?.content ?? "";
  } catch {
    current = "";
  }
  if (current.includes(GITIGNORE_ENTRY)) {
    gitignoredWorkspaces.add(key);
    return;
  }
  const newline = "\n";
  const prefix = current.length === 0 || current.endsWith(newline) ? "" : newline;
  await bridgeFiles.writeFile(".gitignore", current + prefix + GITIGNORE_ENTRY + newline);
  gitignoredWorkspaces.add(key);
}

// ── gallery: list .pi-web/paste via tree API ───────────────────────────────
async function listPasteImages(rt = getRuntime()) {
  const base = workspaceApiBase(rt);
  if (!base) return [];
  const url = `${base}/tree?path=${encodeURIComponent(PASTE_DIR)}`;
  try {
    const response = await fetch(url);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const tree = await response.json();
    const entries = Array.isArray(tree?.entries) ? tree.entries : [];
    return entries
      .filter((entry) => entry?.type === "file" && typeof entry.path === "string" && IMAGE_FILE_RE.test(entry.path))
      .sort((a, b) => String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")))
      .map((entry) => ({
        filePath: entry.path,
        filename: entry.name ?? entry.path.split("/").pop() ?? entry.path,
        serverUrl: previewUrl(entry.path, rt, entry.modifiedAt ?? entry.size ?? "file"),
        ts: entry.modifiedAt ?? entry.size ?? entry.path,
        size: entry.size,
      }));
  } catch (error) {
    console.warn("[screenshot-paste] Could not list .pi-web/paste images", error);
    return [];
  }
}

async function galleryImages(rt = bridgeRuntime, options = {}) {
  const key = runtimeKey(rt);
  const now = Date.now();
  const cached = galleryCacheByWorkspace.get(key);
  if (!options.force && cached?.images && now - cached.fetchedAt < GALLERY_CACHE_TTL_MS) return cached.images;
  if (!options.force && cached?.promise) return cached.promise;

  const promise = (async () => {
    const images = await listPasteImages(rt);
    galleryCacheByWorkspace.set(key, { images, fetchedAt: Date.now(), promise: null });
    return images;
  })();
  galleryCacheByWorkspace.set(key, { images: cached?.images ?? [], fetchedAt: cached?.fetchedAt ?? 0, promise });
  return promise;
}

function invalidateGallery(rt = bridgeRuntime) {
  galleryCacheByWorkspace.delete(runtimeKey(rt));
}

function gallerySignature(images) {
  return images.map((img) => `${img.filePath}:${img.ts ?? ""}:${img.size ?? ""}`).join("|");
}

function fileApiStatusText() {
  if (fileApiStatus === "initialized") return "File API: initialized";
  if (fileApiStatus === "error") return `File API: error — ${fileApiStatusDetail}`;
  return `File API: initializing — ${fileApiStatusDetail}`;
}

function fileApiStatusColor() {
  if (fileApiStatus === "initialized") return "var(--pi-success,#3fb950)";
  if (fileApiStatus === "error") return "var(--pi-error,#f85149)";
  return "var(--pi-muted,#8b949e)";
}

function thumbnailActionStyle() {
  return [
    "width:26px", "height:26px", "display:grid", "place-items:center",
    "border-radius:999px", "border:1px solid rgba(255,255,255,.35)",
    "background:rgba(0,0,0,.72)", "color:white", "font-size:13px",
    "line-height:1", "cursor:pointer", "padding:0",
    "box-shadow:0 2px 10px rgba(0,0,0,.35)",
  ].join(";");
}

// ── panel gallery render ─────────────────────────────────────────────────────
async function renderPanelGallery(options = {}) {
  const containers = querySelectorAllDeep(".screenshot-paste-panel-gallery");
  if (containers.length === 0) return;

  const rt = bridgeRuntime;
  const key = runtimeKey(rt);
  const images = await galleryImages(rt, options);
  if (key !== runtimeKey(bridgeRuntime)) return;

  const signature = gallerySignature(images);
  const emptyMarkup = `<p class="muted">No screenshots found in <code>${PASTE_DIR}/</code>. Paste a screenshot (⌘V) in the chat prompt to save one.</p>`;
  for (const container of containers) {
    if (container.dataset.galleryWorkspace === key && container.dataset.gallerySignature === signature) continue;
    container.dataset.galleryWorkspace = key;
    container.dataset.gallerySignature = signature;
    container.innerHTML = "";
    if (images.length === 0) { container.innerHTML = emptyMarkup; continue; }

    const gallery = document.createElement("div");
    gallery.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;padding:8px 0;justify-content:center;";
    images.forEach((img, idx) => {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = [
        "position:relative", "width:128px", "height:128px", "flex-shrink:0", "border-radius:8px",
        "overflow:hidden", "border:1px solid var(--pi-border,#30363d)",
        "background:var(--pi-border,#30363d)", "cursor:pointer", "transition:transform .15s",
      ].join(";");
      wrapper.onmouseenter = () => (wrapper.style.transform = "scale(1.04)");
      wrapper.onmouseleave = () => (wrapper.style.transform = "");
      const thumb = document.createElement("img");
      thumb.src = img.serverUrl;
      thumb.alt = img.filename;
      thumb.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
      wrapper.appendChild(thumb);
      wrapper.onclick = () => showLightbox(images, idx);

      const actions = document.createElement("div");
      actions.style.cssText = "position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:2;";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "⧉";
      copy.title = "Copy path";
      copy.setAttribute("aria-label", `Copy path for ${img.filename}`);
      copy.style.cssText = thumbnailActionStyle();
      copy.onclick = async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(img.filePath);
          showToast("Path copied");
        } catch {
          showToast("Copy failed", 6000);
        }
      };

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "🗑";
      remove.title = fileApiStatus === "initialized" ? "Delete screenshot" : fileApiStatusText();
      remove.disabled = fileApiStatus !== "initialized";
      remove.setAttribute("aria-label", `Delete ${img.filename}`);
      remove.style.cssText = thumbnailActionStyle() + (remove.disabled ? ";opacity:.45;cursor:not-allowed;" : "");
      remove.onclick = async (event) => {
        event.stopPropagation();
        try {
          await deletePasteImage(img.filePath);
          showToast("Screenshot deleted");
        } catch (error) {
          showToast(error?.message ?? "Delete failed", 6000);
        }
      };

      actions.append(copy, remove);
      wrapper.appendChild(actions);
      gallery.appendChild(wrapper);
    });
    container.appendChild(gallery);
  }
}

// ── lightbox ───────────────────────────────────────────────────────────────
function closeLightbox() {
  const old = document.querySelector(".screenshot-paste-lightbox");
  if (old) old.remove();
  if (activeKeyHandler) {
    window.removeEventListener("keydown", activeKeyHandler, true);
    activeKeyHandler = null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showLightbox(images, index = 0) {
  closeLightbox();
  const img = images[index];
  if (!img) return;

  const dialog = document.createElement("div");
  dialog.className = "screenshot-paste-lightbox";
  dialog.style.cssText = [
    "position:fixed", "inset:0", "z-index:999999", "display:flex", "flex-direction:column",
    "align-items:center", "justify-content:center", "background:rgba(0,0,0,.92)",
    "border:8px solid var(--pi-border,#30363d)", "border-radius:12px", "box-sizing:border-box",
  ].join(";");

  const title = document.createElement("div");
  title.style.cssText = "position:absolute;top:18px;left:80px;right:80px;text-align:center;color:white;";
  const meta = [img.w && img.h ? `${img.w}×${img.h}` : "", img.size ? formatBytes(img.size) : "", img.mimeType ?? ""].filter(Boolean).join(" · ");
  title.innerHTML = `<div style="font-weight:700;font-size:1.2rem;">${img.filename ?? "screenshot"}</div><div style="font-size:1.1rem;opacity:.85;">${meta}</div>`;
  dialog.appendChild(title);

  const image = document.createElement("img");
  image.src = img.serverUrl;
  image.alt = img.filename ?? "screenshot";
  image.style.cssText = "max-width:92vw;max-height:82vh;object-fit:contain;";
  dialog.appendChild(image);

  const close = document.createElement("button");
  close.textContent = "×";
  close.style.cssText = "position:absolute;top:18px;right:24px;font-size:34px;color:white;background:transparent;border:0;cursor:pointer;";
  close.onclick = closeLightbox;
  dialog.appendChild(close);

  const addNav = (side, label, nextIndex) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `position:absolute;${side}:24px;top:50%;transform:translateY(-50%);font-size:42px;color:white;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.25);border-radius:999px;width:58px;height:58px;cursor:pointer;`;
    btn.onclick = () => showLightbox(images, nextIndex);
    dialog.appendChild(btn);
  };
  if (images.length > 1) {
    addNav("left", "‹", (index - 1 + images.length) % images.length);
    addNav("right", "›", (index + 1) % images.length);
  }

  activeKeyHandler = (event) => {
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft" && images.length > 1) showLightbox(images, (index - 1 + images.length) % images.length);
    if (event.key === "ArrowRight" && images.length > 1) showLightbox(images, (index + 1) % images.length);
  };
  window.addEventListener("keydown", activeKeyHandler, true);
  document.body.appendChild(dialog);
}

// ── chat thumbnails (folder mode) — private API, best-effort ───────────────
function findChatRoot() {
  if (cachedChatRoot?.isConnected) return cachedChatRoot;
  cachedChatRoot = querySelectorDeep("chat-view")
    ?? querySelectorDeep("[role=log], .chat-messages, .messages-container")
    ?? querySelectorDeep("main");
  return cachedChatRoot;
}

function markChatDirty() { chatDirty = true; }

function attachChatObserver() {
  if (chatObserver) return true;
  const chatRoot = findChatRoot();
  if (!chatRoot) return false;
  chatObserver = new MutationObserver(markChatDirty);
  chatObserver.observe(chatRoot, { childList: true, subtree: true });
  markChatDirty();
  return true;
}

function startChatPoll() {
  if (chatPoll) return;
  chatPoll = setInterval(() => {
    if (!chatObserver) attachChatObserver();
    if (!chatDirty) return;
    chatDirty = false;
    injectChatThumbnails();
    renderPromptPreviews();
  }, CHAT_POLL_INTERVAL_MS);
}

function refsInText(text) {
  const refs = new Set();
  for (const match of text.matchAll(/(?:@)?(\.(?:pi-web\/paste|pi-paste)\/[^\s)\]]+)/g)) refs.add(match[1]);
  return refs;
}

function injectChatThumbnails() {
  if (!bridgeRuntime) return;
  const chatRoot = findChatRoot();
  const articles = querySelectorAllDeep("article.msg.user, section.group-msg.user", chatRoot ?? document);
  for (const article of articles) {
    const text = article.textContent || "";
    if (!text.includes(".pi-web/paste/") && !text.includes(".pi-paste/")) continue;

    const refs = [...refsInText(text)];
    if (refs.length === 0) continue;

    let container = article.querySelector(":scope > .screenshot-paste-history-strip");
    if (!container) {
      container = document.createElement("div");
      container.className = "screenshot-paste-history-strip";
      container.style.cssText = [
        "display:flex", "flex-wrap:wrap", "gap:8px", "justify-content:center",
        "padding:8px", "margin-top:8px", "border:1px solid var(--pi-border,#30363d)",
        "border-radius:8px", "background:var(--pi-surface,#0d1117)",
      ].join(";");
      article.appendChild(container);
    }

    const existingRefs = new Set([...container.querySelectorAll("img[data-file-path]")].map((img) => img.dataset.filePath));
    let added = false;
    for (const filePath of refs) {
      if (existingRefs.has(filePath)) continue;
      added = true;
      const wrapper = document.createElement("div");
      wrapper.style.cssText = [
        "width:128px", "height:128px", "flex-shrink:0", "border-radius:6px", "overflow:hidden",
        "border:1px solid var(--pi-border,#30363d)", "background:var(--pi-border,#30363d)", "cursor:pointer",
      ].join(";");
      const thumb = document.createElement("img");
      thumb.dataset.filePath = filePath;
      thumb.src = previewUrl(filePath, bridgeRuntime);
      thumb.alt = filePath.split("/").pop();
      thumb.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
      wrapper.onclick = () => showLightbox(refs.map((ref) => ({
        filePath: ref,
        filename: ref.split("/").pop(),
        serverUrl: previewUrl(ref, bridgeRuntime),
      })), refs.indexOf(filePath));
      wrapper.appendChild(thumb);
      container.appendChild(wrapper);
    }
    // Prune refs that are no longer in the message text.
    if (added || existingRefs.size !== refs.length) {
      const refSet = new Set(refs);
      for (const img of [...container.querySelectorAll("img[data-file-path]")]) {
        if (!refSet.has(img.dataset.filePath)) img.parentElement?.remove();
      }
    }
  }
}

// ── toasts ─────────────────────────────────────────────────────────────────
function showToast(message, duration = 3500) {
  let container = document.querySelector(".screenshot-paste-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "screenshot-paste-toast-container";
    container.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;flex-direction:column;gap:8px;";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = "padding:10px 12px;border-radius:8px;background:var(--pi-surface,#161b22);border:1px solid var(--pi-border,#30363d);color:var(--pi-text,#c9d1d9);box-shadow:0 4px 20px rgba(0,0,0,.35);max-width:360px;";
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── clean .pi-web/paste via files API ────────────────────────────────────
async function deletePasteImage(filePath) {
  await deleteWorkspaceFile(filePath);
  invalidateGallery(bridgeRuntime);
  await renderPanelGallery({ force: true });
}

async function cleanPasteImages() {
  const images = await listPasteImages(bridgeRuntime);
  if (images.length === 0) {
    invalidateGallery(bridgeRuntime);
    renderPanelGallery({ force: true });
    return 0;
  }
  const results = await Promise.all(
    images.map((img) => deleteWorkspaceFile(img.filePath).catch(() => null)),
  );
  const deleted = results.filter(Boolean).length;
  invalidateGallery(bridgeRuntime);
  renderPanelGallery({ force: true });
  return deleted;
}

// ── core paste observer (hybrid native input + gallery save) ───────────────
async function doPaste(event) {
  if (!isPasteInPromptEditor(event)) return;
  const items = [...(event.clipboardData?.items ?? [])];
  const files = items
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return;

  // Important: do NOT preventDefault/stopPropagation here.
  // Let pi-web's native PromptEditor handle the paste so the composer keeps its
  // built-in inline thumbnail UI, remove button, and delivery dropdown.
  // The native folder mode saves on send under .pi-web/attachments/, not here;
  // this plugin always saves an immediate gallery copy under .pi-web/paste/.

  if (!bridgeRuntime) bridgeRuntime = getRuntimeFromPiWebApp();
  if (!getRuntime()) return;

  try {
    for (const blob of files) {
      const processed = await processImage(blob);
      if (!processed) continue;
      if (processed.blob.size > MAX_BASE64_LENGTH) {
        console.warn("[screenshot-paste] skipped gallery save: processed image too large");
        continue;
      }

      const image = await writePasteImage(blob, processed);
      invalidateGallery(bridgeRuntime);
      renderPanelGallery({ force: true });
      console.log("[screenshot-paste] saved gallery copy", image.filePath);
    }
  } catch (error) {
    // Native paste already succeeded; gallery save failure should not break input UX.
    console.warn("[screenshot-paste] gallery copy save failed:", error);
  }
}

// ── plugin ─────────────────────────────────────────────────────────────────
const plugin = {
  apiVersion: 1,
  name: "Screenshot Paste",

  activate: ({ html, svg }) => {
    startChatPoll();

    if (!handlePaste) {
      handlePaste = (event) => { void doPaste(event); };
      document.addEventListener("paste", handlePaste, true);
    }

    return {
      contributions: {
        actions: [
          {
            id: "open-paste-panel",
            title: "Open Paste Gallery",
            description: "Open the Paste panel to browse screenshots",
            shortcut: "mod+shift+v",
            group: "Screenshot",
            enabled: (context) => {
              updateRuntime(context);
              return context.state.selectedWorkspace !== undefined;
            },
            run: (context) => {
              updateRuntime(context);
              const tool = context.selectWorkspaceTool;
              if (typeof tool === "function") {
                try { tool("screenshot-paste:paste"); return; } catch { /* fall through */ }
              }
              showToast("Open the Paste panel from the workspace tabs to browse screenshots.");
            },
          },
        ],
        workspacePanels: [
          {
            id: "paste",
            title: "Paste",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            `,
            order: 9999,
            badge: (context) => {
              captureFilesApi(context, "panel-badge");
              const cached = galleryCacheByWorkspace.get(runtimeKey(getRuntime()));
              return cached?.images?.length > 0 ? String(cached.images.length) : undefined;
            },
            render: (context) => {
              updateBridgeFromPanel(context);
              void ensurePasteGitignored();
              queueMicrotask(() => renderPanelGallery());
              const machineName = context.machine?.name ?? context.machine?.id ?? "local";
              return html`
                <section class="toolbar" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                  <strong>Screenshot Paste</strong>
                  <button @click=${async () => {
                    if (!confirm(`Delete all files in ${PASTE_DIR}/ for this workspace?`)) return;
                    try {
                      const deleted = await cleanPasteImages();
                      showToast(deleted > 0 ? `Deleted ${String(deleted)} file(s)` : "Nothing to delete");
                    } catch (error) {
                      showToast(error?.message ?? "Clean failed", 6000);
                    }
                  }} style="padding:7px 12px;background:var(--pi-error-bg,rgba(248,81,73,.12));border:1px solid var(--pi-error,#f85149);color:var(--pi-error,#f85149);border-radius:8px;cursor:pointer;font-weight:600;">
                    Clean Gallery
                  </button>
                </section>
                <section class="viewer">
                  <p class="muted" style="margin:8px 0 14px;">${machineName} · ${context.workspace?.path ?? ""}</p>
                  <div class="screenshot-paste-panel-gallery"></div>
                  <p class="muted" style=${`margin:12px 0 0;font-size:12px;color:${fileApiStatusColor()};`}>${fileApiStatusText()}</p>
                </section>
              `;
            },
          },
        ],
        // Label tracker: keeps workspace/machine/runtime fresh even when the
        // Paste panel is closed. Does NOT provide files (labels only have readFile).
        workspaceLabels: [
          {
            id: "paste-runtime-tracker",
            order: 9999,
            visible: (context) => {
              updateBridgeFromLabel(context);
              return false;
            },
            items: () => [],
          },
        ],
      },
    };
  },
};

export default plugin;

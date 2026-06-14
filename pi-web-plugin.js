const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;
const MAX_BASE64_LENGTH = 5_000_000;
const PLUGIN_VERSION = "0.3.0";
const PLUGIN_INSTANCE_ID = Math.random().toString(36).slice(2);
const PLUGIN_RUNTIME_KEY = "__screenshotPastePluginState";

// ── state ──────────────────────────────────────────────────────────────────
let currentRuntime = null;
let handlePaste = null;
let isProcessing = false;
let stripPollInterval = null;
let stripObserver = null;
let lastStripSignature = "";

const knownImagesByWorkspace = new Map();
const galleryCacheByWorkspace = new Map();
const GALLERY_CACHE_TTL_MS = 5000;

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp)$/iu;

function workspaceKey(runtime = currentRuntime) {
  if (!runtime) return "unknown";
  return `${runtime.machineId}:${runtime.projectId}:${runtime.workspaceId}`;
}

function updateRuntimeFromContext(context) {
  const workspace = context?.workspace ?? context?.state?.selectedWorkspace ?? null;
  if (!workspace?.path || !workspace?.projectId || !workspace?.id) return currentRuntime;

  const machine = context?.machine ?? { id: "local", name: "local", kind: "local" };
  currentRuntime = {
    machineId: machine.id ?? "local",
    machineName: machine.name ?? machine.id ?? "local",
    machineKind: machine.kind ?? "local",
    workspace,
    workspacePath: workspace.path,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    files: context?.files ?? currentRuntime?.files,
    attachments: context?.attachments ?? currentRuntime?.attachments,
    prompt: context?.prompt ?? currentRuntime?.prompt,
  };
  return currentRuntime;
}

function requireRuntimeForWrite() {
  if (!currentRuntime?.workspacePath || !currentRuntime?.projectId || !currentRuntime?.workspaceId) {
    throw new Error("No active workspace selected. Select a workspace before pasting screenshots.");
  }
  if (!currentRuntime?.files?.writeFile) {
    throw new Error("Workspace file API not available yet. Open the Paste panel once to activate it.");
  }
  return currentRuntime;
}

function rememberKnownImage(image, runtime = currentRuntime) {
  const key = workspaceKey(runtime);
  const list = knownImagesByWorkspace.get(key) ?? [];
  if (!list.some((item) => item.filePath === image.filePath)) list.push(image);
  knownImagesByWorkspace.set(key, list);
}

function currentKnownImages() {
  return knownImagesByWorkspace.get(workspaceKey()) ?? [];
}

function currentAttachedPasteImages() {
  if (!currentRuntime?.attachments?.getAttachedFiles) return [];
  return currentRuntime.attachments
    .getAttachedFiles()
    .filter((path) => path.startsWith(".pi-paste/"))
    .map((path) => ({
      filePath: path,
      filename: path.split("/").pop() ?? path,
      serverUrl: previewUrl(path, currentRuntime),
    }));
}

// ── gallery via stable workspace file APIs ─────────────────────────────────
function previewUrl(filePath, runtime = currentRuntime, version = Date.now()) {
  if (!runtime) return "";
  const params = new URLSearchParams();
  params.set("path", filePath);
  params.set("v", String(version));
  return `/api/machines/${encodeURIComponent(runtime.machineId)}`
    + `/projects/${encodeURIComponent(runtime.projectId)}`
    + `/workspaces/${encodeURIComponent(runtime.workspaceId)}`
    + `/file/preview?${params.toString()}`;
}

async function listWorkspacePasteImages(runtime = currentRuntime) {
  if (!runtime?.machineId || !runtime?.projectId || !runtime?.workspaceId) return [];
  const url = `/api/machines/${encodeURIComponent(runtime.machineId)}`
    + `/projects/${encodeURIComponent(runtime.projectId)}`
    + `/workspaces/${encodeURIComponent(runtime.workspaceId)}`
    + `/tree?path=${encodeURIComponent(".pi-paste")}`;

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
        serverUrl: previewUrl(entry.path, runtime, entry.modifiedAt ?? entry.size ?? "file"),
        ts: entry.modifiedAt ?? entry.size ?? entry.path,
        size: entry.size,
      }));
  } catch (error) {
    console.warn("[screenshot-paste] Could not list workspace .pi-paste images", error);
    return [];
  }
}

async function currentGalleryImages(runtime = currentRuntime, options = {}) {
  const key = workspaceKey(runtime);
  const now = Date.now();
  const cached = galleryCacheByWorkspace.get(key);
  if (!options.force && cached?.images && now - cached.fetchedAt < GALLERY_CACHE_TTL_MS) return cached.images;
  if (!options.force && cached?.promise) return cached.promise;

  const promise = (async () => {
    const byPath = new Map();
    for (const image of knownImagesByWorkspace.get(key) ?? []) byPath.set(image.filePath, image);
    for (const image of await listWorkspacePasteImages(runtime)) byPath.set(image.filePath, image);
    const images = [...byPath.values()].sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
    galleryCacheByWorkspace.set(key, { images, fetchedAt: Date.now(), promise: null });
    return images;
  })();

  galleryCacheByWorkspace.set(key, { images: cached?.images ?? [], fetchedAt: cached?.fetchedAt ?? 0, promise });
  return promise;
}

function invalidateGallery(runtime = currentRuntime) {
  galleryCacheByWorkspace.delete(workspaceKey(runtime));
}

function gallerySignature(images) {
  return images.map((img) => `${img.filePath}:${img.ts ?? ""}:${img.size ?? ""}`).join("|");
}

// ── deep DOM query scoped to the panel container ───────────────────────────
const SHADOW_DEPTH_LIMIT = 3;

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

// ── image processing ─────────────────────────────────────────────────────
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ── stable workspace file operations ───────────────────────────────────────
async function ensureGitignore(runtime) {
  if (!runtime?.files?.readFile || !runtime?.files?.writeFile) return;
  try {
    const entry = ".pi-paste/";
    let content = "";
    try {
      const file = await runtime.files.readFile(".gitignore");
      content = file.content ?? "";
    } catch {
      // .gitignore may not exist
    }
    if (content.includes(entry)) return;
    const newline = content.endsWith("\n") || content.length === 0 ? "" : "\n";
    await runtime.files.writeFile(".gitignore", `${content}${newline}${entry}\n`);
  } catch (error) {
    console.warn("[screenshot-paste] Could not update .gitignore", error);
  }
}

async function uploadImageToWorkspace(base64, filename) {
  const runtime = requireRuntimeForWrite();
  const bytes = base64ToUint8Array(base64);
  const filePath = `.pi-paste/${filename}`;
  await runtime.files.writeFile(filePath, bytes);
  await ensureGitignore(runtime);

  const ts = Date.now();
  const image = {
    serverUrl: previewUrl(filePath, runtime, ts),
    filePath,
    ts,
    filename,
    size: bytes.byteLength,
  };
  rememberKnownImage(image, runtime);
  invalidateGallery(runtime);
  return image;
}

async function cleanWorkspacePasteImages() {
  const runtime = requireRuntimeForWrite();
  const images = await currentGalleryImages(runtime, { force: true });
  for (const image of images) {
    try {
      await runtime.files.deleteFile(image.filePath);
    } catch (error) {
      console.warn(`[screenshot-paste] Could not delete ${image.filePath}`, error);
    }
  }
  knownImagesByWorkspace.set(workspaceKey(runtime), []);
  invalidateGallery(runtime);
  renderPanelGallery({ force: true });
}

async function insertFileReference(filePath) {
  if (!currentRuntime?.attachments?.insertFileReference) {
    console.warn("[screenshot-paste] attachments.insertFileReference not available; falling back to prompt.insertText");
    currentRuntime?.prompt?.insertText?.(`@${filePath} `);
    renderStagingStrip();
    return;
  }
  try {
    await currentRuntime.attachments.insertFileReference(filePath);
    renderStagingStrip();
  } catch (error) {
    console.warn("[screenshot-paste] Could not insert file reference via attachments API, falling back", error);
    currentRuntime?.prompt?.insertText?.(`@${filePath} `);
    renderStagingStrip();
  }
}

function removeFileReference(filePath) {
  if (!currentRuntime?.attachments?.removeFileReference) {
    console.warn("[screenshot-paste] attachments.removeFileReference not available");
    return;
  }
  currentRuntime.attachments.removeFileReference(filePath);
  renderStagingStrip();
}

// ── prompt staging strip (re-added using stable attachments API) ────────────
function findPromptEditor() {
  const editor = document.querySelector("prompt-editor") ?? querySelectorDeep("prompt-editor");
  if (editor?.isConnected) return editor;
  return null;
}

function removeOrphanStagingStrips(activeStrip = null) {
  const editor = findPromptEditor();
  for (const strip of document.querySelectorAll(".screenshot-paste-staging-strip")) {
    if (strip === activeStrip) continue;
    if (!editor || strip.nextElementSibling !== editor) strip.remove();
  }
}

function ensureStagingStrip() {
  const editor = findPromptEditor();
  if (!editor) {
    removeOrphanStagingStrips();
    return null;
  }
  const host = editor.parentElement;
  if (!host) {
    removeOrphanStagingStrips();
    return null;
  }
  let strip = editor.previousElementSibling?.classList?.contains("screenshot-paste-staging-strip")
    ? editor.previousElementSibling
    : null;
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "screenshot-paste-staging-strip";
    host.insertBefore(strip, editor);
  }
  removeOrphanStagingStrips(strip);
  strip.style.cssText = [
    "display:flex", "flex-wrap:wrap", "gap:14px", "justify-content:center",
    "padding:14px", "margin:6px 0", "border:1px solid var(--pi-border,#30363d)",
    "border-radius:8px", "background:var(--pi-surface,#0d1117)",
  ].join(";");
  return strip;
}

function stripSignature(images) {
  return images.map((img) => img.filePath).join("|");
}

function renderStagingStrip() {
  const images = currentAttachedPasteImages();
  const signature = stripSignature(images);
  if (signature === lastStripSignature) return;
  lastStripSignature = signature;

  const strip = ensureStagingStrip();
  if (!strip) return;
  strip.innerHTML = "";
  if (images.length === 0) {
    strip.remove();
    removeOrphanStagingStrips();
    lastStripSignature = "";
    return;
  }

  images.forEach((img, idx) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = [
      "position:relative", "width:128px", "height:128px", "flex-shrink:0",
      "border-radius:6px", "overflow:visible", "border:1px solid var(--pi-border,#30363d)",
      "background:var(--pi-border,#30363d)", "cursor:pointer",
    ].join(";");
    const thumb = document.createElement("img");
    thumb.src = img.serverUrl;
    thumb.alt = img.filename;
    thumb.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;border-radius:6px;";
    thumb.onclick = () => showLightbox(images, idx);
    wrapper.appendChild(thumb);

    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Remove from message";
    close.style.cssText = [
      "position:absolute", "top:-10px", "right:-10px", "z-index:2",
      "width:24px", "height:24px", "padding:0",
      "display:flex", "align-items:center", "justify-content:center",
      "border-radius:50%", "border:1px solid rgba(255,255,255,.45)",
      "background:rgba(0,0,0,.72)", "color:white", "cursor:pointer",
      "font-size:18px", "font-weight:700", "line-height:1",
      "box-shadow:0 2px 8px rgba(0,0,0,.35)",
    ].join(";");
    close.onclick = (event) => {
      event.stopPropagation();
      removeStagingImage(img.filePath);
    };
    wrapper.appendChild(close);
    strip.appendChild(wrapper);
  });
}

function removeStagingImage(filePath) {
  if (currentRuntime?.attachments?.removeFileReference) {
    currentRuntime.attachments.removeFileReference(filePath);
  } else {
    console.warn("[screenshot-paste] Cannot remove staging image: attachments.removeFileReference not available");
  }
  renderStagingStrip();
}

function stopStripWatcher() {
  if (stripPollInterval) {
    clearInterval(stripPollInterval);
    stripPollInterval = null;
  }
  if (stripObserver) {
    stripObserver.disconnect();
    stripObserver = null;
  }
}

function startStripWatcher() {
  stopStripWatcher();
  stripObserver = new MutationObserver(() => {
    const editor = findPromptEditor();
    if (editor) {
      renderStagingStrip();
      if (!stripPollInterval) {
        stripPollInterval = window.setInterval(() => {
          if (!findPromptEditor()) {
            stopStripWatcher();
            return;
          }
          renderStagingStrip();
        }, 400);
      }
    } else {
      removeOrphanStagingStrips();
    }
  });
  stripObserver.observe(document.body, { childList: true, subtree: true });
  renderStagingStrip();
}

// ── panel gallery rendering ────────────────────────────────────────────────
async function renderPanelGallery(options = {}) {
  const containers = querySelectorAllDeep(".screenshot-paste-panel-gallery");
  if (containers.length === 0) return;

  const runtime = currentRuntime;
  const runtimeKey = workspaceKey(runtime);
  const images = await currentGalleryImages(runtime, options);
  if (runtimeKey !== workspaceKey(currentRuntime)) return;

  const signature = gallerySignature(images);
  const emptyMarkup = `<p class="muted">No screenshots found in <code>.pi-paste/</code>. Paste a screenshot (⌘V) to save one in this workspace.</p>`;
  for (const container of containers) {
    if (container.dataset.galleryWorkspace === runtimeKey && container.dataset.gallerySignature === signature) continue;
    container.dataset.galleryWorkspace = runtimeKey;
    container.dataset.gallerySignature = signature;
    if (images.length === 0) {
      container.innerHTML = emptyMarkup;
      continue;
    }

    const gallery = document.createElement("div");
    gallery.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;padding:8px;justify-content:center;";
    images.forEach((img, idx) => {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = [
        "position:relative", "width:128px", "height:128px", "flex-shrink:0", "border-radius:6px",
        "overflow:hidden", "border:1px solid var(--pi-border,#30363d)",
        "background:var(--pi-border,#30363d)", "cursor:pointer", "transition:transform .15s",
      ].join(";");
      wrapper.onmouseenter = () => (wrapper.style.transform = "scale(1.05)");
      wrapper.onmouseleave = () => (wrapper.style.transform = "");
      const thumb = document.createElement("img");
      thumb.src = img.serverUrl;
      thumb.alt = img.filename;
      thumb.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
      wrapper.appendChild(thumb);
      wrapper.onclick = () => showLightbox(images, idx);
      gallery.appendChild(wrapper);
    });
    container.innerHTML = "";
    container.appendChild(gallery);
  }
}

// ── lightbox ───────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function closeLightbox() {
  const old = document.querySelector(".screenshot-paste-lightbox");
  if (old) old.remove();
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

  const keyHandler = (event) => {
    if (event.key === "Escape") {
      closeLightbox();
      window.removeEventListener("keydown", keyHandler, true);
    }
    if (event.key === "ArrowLeft" && images.length > 1) showLightbox(images, (index - 1 + images.length) % images.length);
    if (event.key === "ArrowRight" && images.length > 1) showLightbox(images, (index + 1) % images.length);
  };
  window.addEventListener("keydown", keyHandler, true);
  document.body.appendChild(dialog);
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

// ── core paste logic ──────────────────────────────────────────────────────
function isPasteInPromptEditor(event) {
  return event.composedPath().some((el) => el?.localName === "prompt-editor" || el?.tagName === "PROMPT-EDITOR");
}

async function doPaste(event) {
  if (isProcessing) return;
  const items = [...(event.clipboardData?.items ?? [])];
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (imageItems.length === 0) return;

  event.preventDefault();
  isProcessing = true;
  try {
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const processed = await processImage(blob);
      if (!processed) continue;
      const base64 = await blobToBase64(processed.blob);
      if (base64.length > MAX_BASE64_LENGTH) {
        showToast("Image too large after processing (>5MB), try a smaller screenshot");
        continue;
      }

      const ts = Date.now();
      const rnd = Math.random().toString(36).slice(2, 6);
      const ext = processed.mimeType.split("/")[1] || "png";
      const filename = `pi-paste-${ts}-${rnd}.${ext}`;
      const image = await uploadImageToWorkspace(base64, filename);
      await insertFileReference(image.filePath);
      renderPanelGallery({ force: true });
    }
  } catch (error) {
    console.error("[screenshot-paste] paste failed:", error);
    showToast(error?.message ?? "Failed to paste screenshot", 6000);
  } finally {
    isProcessing = false;
  }
}

function cleanupPluginRuntime() {
  if (handlePaste) {
    document.removeEventListener("paste", handlePaste, true);
    handlePaste = null;
  }
  stopStripWatcher();
}

function installPluginRuntimeGuard() {
  const existing = window[PLUGIN_RUNTIME_KEY];
  if (existing?.instanceId === PLUGIN_INSTANCE_ID) return;
  try {
    existing?.cleanup?.();
  } catch (error) {
    console.warn("[screenshot-paste] Could not cleanup previous plugin runtime", error);
  }
  cleanupPluginRuntime();
  window[PLUGIN_RUNTIME_KEY] = {
    version: PLUGIN_VERSION,
    instanceId: PLUGIN_INSTANCE_ID,
    cleanup: cleanupPluginRuntime,
  };
}

// ── plugin ─────────────────────────────────────────────────────────────────
const plugin = {
  apiVersion: 1,
  name: "Screenshot Paste",

  activate: ({ html, svg }) => {
    installPluginRuntimeGuard();

    if (!handlePaste) {
      handlePaste = (event) => {
        if (!isPasteInPromptEditor(event)) return;
        void doPaste(event);
      };
      document.addEventListener("paste", handlePaste, true);
    }
    startStripWatcher();

    return {
      contributions: {
        actions: [
          {
            id: "paste-screenshot",
            title: "Paste Screenshot",
            description: "Paste a screenshot from clipboard into the active workspace as an @file image attachment",
            shortcut: "mod+shift+v",
            group: "Screenshot",
            enabled: (context) => {
              updateRuntimeFromContext(context);
              queueMicrotask(renderStagingStrip);
              return context.state.selectedSession !== undefined && context.state.selectedWorkspace !== undefined;
            },
            run: (context) => {
              updateRuntimeFromContext(context);
              if (!currentRuntime?.files?.writeFile) {
                showToast("Open the Paste panel once to activate workspace file access, then try again.", 5000);
                return;
              }
              void (async () => {
                try {
                  const items = await navigator.clipboard.read();
                  for (const item of items) {
                    const imageType = item.types.find((t) => t.startsWith("image/"));
                    if (!imageType) continue;
                    const blob = await item.getType(imageType);
                    const syntheticEvent = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
                    const syntheticCd = new DataTransfer();
                    syntheticCd.items.add(new File([blob], "paste.png", { type: imageType }));
                    Object.defineProperty(syntheticEvent, "clipboardData", { value: syntheticCd });
                    await doPaste(syntheticEvent);
                  }
                } catch (error) {
                  showToast(error?.message ?? "Could not read clipboard. Try ⌘V directly in the message box instead.", 6000);
                }
              })();
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
              updateRuntimeFromContext(context);
              const count = currentAttachedPasteImages().length;
              return count > 0 ? String(count) : undefined;
            },
            render: (context) => {
              updateRuntimeFromContext(context);
              queueMicrotask(() => {
                renderPanelGallery();
                renderStagingStrip();
              });
              const attached = currentAttachedPasteImages();
              const broomIcon = svg`
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;">
                  <path d="M9 18l3-3"/>
                  <path d="M13 12h2l4-4a2.828 2.828 0 1 0-4-4l-4 4v2"/>
                  <path d="M15 10l-3.5 3.5"/>
                  <path d="M20 21l-2-2"/>
                  <path d="M7 20l-4-4c-1-1-1-3 0-4l8-8"/>
                </svg>
              `;
              return html`
                <section class="toolbar"><strong>Screenshot Paste</strong></section>
                <section class="viewer">
                  <p class="muted">Stable API mode · ${context.machine.name} · ${context.workspace.path}</p>
                  <p class="muted">Paste screenshots (⌘V) in the chat prompt to save them to <code>.pi-paste/</code> and insert <code>@.pi-paste/…</code>.</p>
                  ${attached.length > 0 ? html`<p style="margin:8px 0 4px;font-size:13px;"><strong>${attached.length}</strong> image(s) attached in prompt</p>` : null}
                  <p class="muted">Gallery lists image files currently found in this workspace’s <code>.pi-paste/</code> folder.</p>
                  <div class="screenshot-paste-panel-gallery"></div>
                  <button @click=${async () => {
                    if (!confirm("Delete all files in .pi-paste/ for this workspace?")) return;
                    try {
                      await cleanWorkspacePasteImages();
                      showToast("Paste images cleaned");
                    } catch (error) {
                      showToast(error?.message ?? "Clean failed", 6000);
                    }
                  }} style="margin-top:8px;padding:4px 12px;background:var(--pi-error-bg);border:1px solid var(--pi-error);color:var(--pi-error);border-radius:4px;cursor:pointer;">
                    ${broomIcon} Clean .pi-paste images
                  </button>
                </section>
              `;
            },
          },
        ],
        workspaceLabels: [
          {
            id: "paste-status",
            order: 90,
            visible: (context) => {
              updateRuntimeFromContext(context);
              return currentAttachedPasteImages().length > 0;
            },
            items: (context) => {
              updateRuntimeFromContext(context);
              return currentAttachedPasteImages().map((img, idx) => ({
                type: "text",
                text: `img ${idx + 1}`,
                title: img.filePath,
              }));
            },
          },
        ],
      },
    };
  },
};

export default plugin;

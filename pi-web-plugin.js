// @private-api: This plugin accesses the prompt-editor shadow DOM and its
// CodeMirror EditorView instance. These are private/experimental PI WEB surfaces
// that may change shape or disappear across versions. All private API access is
// isolated in clearly-marked functions with fallback error handling.

const SERVER_URL = "http://localhost:9876";
const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;

// ── state ──────────────────────────────────────────────────────────────────
let workspacePath = null;
let serverAvailable = false;
const pendingImages = []; // { blobUrl, filePath, ts, filename }

// ── deep DOM query (pierces shadow roots) ──────────────────────────────
function querySelectorDeep(selector, root = document) {
  const found = root.querySelector(selector);
  if (found) return found;
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const result = querySelectorDeep(selector, el.shadowRoot);
      if (result) return result;
    }
  }
  return null;
}
function querySelectorAllDeep(selector, root = document) {
  const results = [];
  function search(node) {
    results.push(...node.querySelectorAll(selector));
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) search(el.shadowRoot);
    }
  }
  search(root);
  return results;
}

// ── panel gallery polling ────────────────────────────────────────────────
let panelPollInterval = null;

function startPanelPoll() {
  if (panelPollInterval) return;
  async function poll() {
    try {
      const params = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
      const res = await fetch(`${SERVER_URL}/images${params}`);
      if (!res.ok) return;
      const images = await res.json();
      const containers = querySelectorAllDeep(".screenshot-paste-panel-gallery");
      if (images.length === 0) {
        containers.forEach((c) => { c.innerHTML = `<p class="muted">No images uploaded yet. Paste a screenshot (⌘V) to see it here.</p>`; });
        return;
      }
      // Build gallery with flex wrap — images keep fixed size, flex organizes by width
      const galleryDiv = document.createElement("div");
      galleryDiv.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;padding:8px;justify-content:center;";
      const imageList = images.map((img) => {
        const qs = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
        return { url: `${SERVER_URL}/images/${img.filename}${qs}`, filename: img.filename };
      });
      imageList.forEach((item, idx) => {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = [
          "position:relative", "width:128px", "height:128px", "flex-shrink:0",
          "border-radius:6px", "overflow:hidden",
          "border:1px solid var(--pi-border,#30363d)",
          "background:var(--pi-border,#30363d)", "cursor:pointer",
          "transition:transform 0.15s",
        ].join(";");
        wrapper.onmouseenter = () => (wrapper.style.transform = "scale(1.05)");
        wrapper.onmouseleave = () => (wrapper.style.transform = "");
        const thumb = document.createElement("img");
        thumb.src = item.url;
        thumb.alt = item.filename;
        thumb.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
        wrapper.appendChild(thumb);
        wrapper.onclick = () => showLightbox(imageList, idx);
        galleryDiv.appendChild(wrapper);
      });
      containers.forEach((c) => { c.innerHTML = ""; c.appendChild(galleryDiv); });
    } catch { /* best effort */ }
  }
  poll();
  panelPollInterval = setInterval(poll, 2000);
}

function stopPanelPoll() {
  if (panelPollInterval) {
    clearInterval(panelPollInterval);
    panelPollInterval = null;
  }
}

// ── image processing ───────────────────────────────────────────────────────

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

// ── server API ─────────────────────────────────────────────────────────────

async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { method: "GET" });
    serverAvailable = res.ok;
    return serverAvailable;
  } catch {
    serverAvailable = false;
    return false;
  }
}

async function uploadImage(base64, filename) {
  const res = await fetch(`${SERVER_URL}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, filename, workspace: workspacePath }),
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

async function fetchGallery() {
  const params = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
  const res = await fetch(`${SERVER_URL}/images${params}`);
  if (!res.ok) return [];
  return res.json();
}

async function cleanImages() {
  const params = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
  const res = await fetch(`${SERVER_URL}/clean${params}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Clean failed");
  return res.json();
}

// ── gitignore helper ───────────────────────────────────────────────────────

function ensureGitignore() {
  if (!workspacePath) return;
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const gitignorePath = path.join(workspacePath, ".gitignore");
    const entry = ".pi-paste/";
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      if (!content.includes(entry)) {
        fs.appendFileSync(gitignorePath, `\n${entry}\n`);
      }
    }
  } catch { /* best effort */ }
}

// ── prompt-editor interaction (@private-api) ───────────────────────────────

let cachedPromptEditor = null;

function getPromptEditor() {
  try {
    return cachedPromptEditor ?? document.querySelector("prompt-editor") ?? null;
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

function removeFileRefFromEditor(filePath) {
  try {
    const view = getPromptEditor()?.editor;
    if (!view) return false;
    const doc = view.state.doc;
    const text = doc.toString();
    const ref = `@${filePath}`;
    const idx = text.indexOf(ref);
    if (idx === -1) return false;
    let from = idx;
    let to = idx + ref.length;
    if (from > 0 && text[from - 1] === "\n") {
      from--;
      if (from > 0 && text[from - 1] === "\n") from--;
    }
    if (to < text.length && text[to] === "\n") to++;
    view.dispatch({ changes: { from, to, insert: "" } });
    return true;
  } catch { return false; }
}

function isPasteInPromptEditor(event) {
  try {
    return event.composedPath().some(
      (el) => el.localName === "prompt-editor" || el.tagName === "PROMPT-EDITOR",
    );
  } catch { return false; }
}

// ── thumbnail strip ────────────────────────────────────────────────────────

function getOrCreateStrip() {
  try {
    const promptEl = getPromptEditor();
    if (!promptEl || !promptEl.parentNode) return null;
    let strip = promptEl.previousElementSibling;
    if (strip?.classList.contains("screenshot-paste-strip")) return strip;
    strip = document.createElement("div");
    strip.className = "screenshot-paste-strip";
    strip.style.cssText = [
      "display:none", "flex-direction:row", "gap:8px",
      "padding:6px 12px 2px", "align-items:center", "flex-wrap:wrap",
      "border-bottom:1px solid var(--pi-border,#30363d)",
      "background:var(--pi-surface,#161b22)",
    ].join(";");
    promptEl.parentNode.insertBefore(strip, promptEl);
    return strip;
  } catch { return null; }
}

function renderThumbnails() {
  try {
    const strip = getOrCreateStrip();
    if (!strip) return;
    while (strip.firstChild) strip.removeChild(strip.firstChild);
    if (pendingImages.length === 0) { strip.style.display = "none"; return; }
    strip.style.display = "flex";
    pendingImages.forEach((img, idx) => {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = [
        "position:relative", "width:128px", "height:128px",
        "border-radius:4px", "overflow:hidden",
        "border:1px solid var(--pi-border,#30363d)",
        "background:var(--pi-border,#30363d)", "cursor:pointer",
      ].join(";");
      const thumb = document.createElement("img");
      thumb.src = img.serverUrl;
      thumb.style.cssText = ["width:100%", "height:100%", "display:block", "object-fit:contain"].join(";");
      wrapper.appendChild(thumb);
      wrapper.onclick = () => {
        const list = pendingImages.map((p) => ({ url: p.serverUrl, filename: p.filename }));
        showLightbox(list, idx);
      };

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "\u00d7";
      removeBtn.title = "Remove image";
      removeBtn.style.cssText = [
        "position:absolute", "top:0", "right:0",
        "background:rgba(0,0,0,0.7)", "color:#fff", "border:none",
        "cursor:pointer", "font-size:11px", "line-height:16px",
        "width:16px", "padding:0", "text-align:center", "border-radius:0 4px 0 4px",
      ].join(";");
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removeFileRefFromEditor(img.filePath);
        pendingImages.splice(idx, 1);
        renderThumbnails();
      };
      wrapper.appendChild(removeBtn);
      strip.appendChild(wrapper);
    });
  } catch { /* best effort */ }
}

// ── chat history thumbnails ──────────────────────────────────────────────
// Poll for user messages that contain @.pi-paste/ references and inject
// clickable thumbnails below them. Uses deep DOM queries to pierce shadow roots.

const sentImages = new Map(); // filePath → { filename }
let chatPollInterval = null;
const processedMessages = new WeakSet();

function startChatPoll() {
  if (chatPollInterval) return;
  chatPollInterval = setInterval(() => {
    if (sentImages.size === 0) return;
    injectChatThumbnails();
  }, 500);
}

function stopChatPoll() {
  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
}

function injectChatThumbnails() {
  try {
    // Find all user message articles across shadow DOMs
    const allArticles = querySelectorAllDeep("article.msg.user");
    for (const article of allArticles) {
      if (processedMessages.has(article)) continue;
      const text = article.textContent ?? "";
      if (!text.includes(".pi-paste/")) continue;

      // This message contains paste references — inject thumbnails
      const container = document.createElement("div");
      container.className = "screenshot-paste-inline";
      container.style.cssText = [
        "display:flex", "flex-direction:row", "gap:8px",
        "padding:4px 0 8px", "align-items:center", "flex-wrap:wrap",
      ].join(";");

      const chatImageList = [];
      for (const [filePath, info] of sentImages) {
        const qs = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
        chatImageList.push({
          url: `${SERVER_URL}/images/${info.filename}${qs}`,
          filename: info.filename,
        });
      }
      chatImageList.forEach((item, idx) => {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = [
          "position:relative", "width:128px", "height:128px",
          "border-radius:6px", "overflow:hidden",
          "border:1px solid var(--pi-border,#30363d)",
          "background:var(--pi-border,#30363d)", "cursor:pointer",
          "transition:transform 0.15s",
        ].join(";");
        wrapper.onmouseenter = () => (wrapper.style.transform = "scale(1.05)");
        wrapper.onmouseleave = () => (wrapper.style.transform = "");

        const thumb = document.createElement("img");
        thumb.src = item.url;
        thumb.alt = "Pasted screenshot";
        thumb.style.cssText = [
          "width:100%", "height:100%", "display:block", "object-fit:contain",
        ].join(";");
        wrapper.appendChild(thumb);
        wrapper.onclick = () => showLightbox(chatImageList, idx);
        container.appendChild(wrapper);
      });
      article.appendChild(container);
      processedMessages.add(article);
    }
    sentImages.clear();
  } catch { /* best effort */ }
}


let lightboxImages = []; // { url, filename }[]
let lightboxIndex = 0;
let activeKeyHandler = null;

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function showLightbox(images, startIndex = 0) {
  if (!Array.isArray(images)) images = [{ url: images, filename: "" }];
  lightboxImages = images;
  lightboxIndex = Math.max(0, Math.min(startIndex, images.length - 1));
  renderLightbox();
}

function renderLightbox() {
  // BUG FIX: always remove old listener before re-rendering
  if (activeKeyHandler) {
    document.removeEventListener("keydown", activeKeyHandler);
    activeKeyHandler = null;
  }
  // Remove old DOM
  const old = document.querySelector(".screenshot-paste-lightbox");
  if (old) old.remove();

  const current = lightboxImages[lightboxIndex];
  if (!current) return;

  // Fullscreen dialog with border
  const dialog = document.createElement("div");
  dialog.className = "screenshot-paste-lightbox";
  dialog.style.cssText = [
    "position:fixed", "inset:0", "z-index:99999",
    "background:rgba(0,0,0,0.92)",
    "border:8px solid var(--pi-border,#30363d)",
    "border-radius:12px",
    "display:flex", "flex-direction:column",
    "overflow:hidden",
  ].join(";");

  // ── Title bar ──
  const titleBar = document.createElement("div");
  titleBar.style.cssText = [
    "flex-shrink:0", "padding:12px 20px",
    "border-bottom:1px solid var(--pi-border,#30363d)",
    "background:var(--pi-surface,#161b22)",
    "display:flex", "align-items:center", "justify-content:center",
    "position:relative", "min-height:52px",
  ].join(";");

  const titleGroup = document.createElement("div");
  titleGroup.style.cssText = "display:flex;flex-direction:column;gap:2px;align-items:center;text-align:center;max-width:calc(100% - 60px);";

  const title = document.createElement("div");
  title.textContent = current.filename || "Image";
  title.style.cssText = "font-size:1.2rem;font-weight:bold;color:var(--pi-fg,#e6edf3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;";
  titleGroup.appendChild(title);

  const subtitle = document.createElement("div");
  subtitle.style.cssText = "font-size:1.1rem;color:var(--pi-muted,#8b949e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;";
  subtitle.textContent = "Loading...";
  titleGroup.appendChild(subtitle);
  titleBar.appendChild(titleGroup);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText = [
    "position:absolute", "right:12px", "top:50%", "transform:translateY(-50%)",
    "width:32px", "height:32px", "border-radius:50%",
    "background:transparent", "color:var(--pi-muted,#8b949e)",
    "font-size:22px", "border:none", "cursor:pointer",
    "display:flex", "align-items:center", "justify-content:center",
    "flex-shrink:0",
  ].join(";");
  closeBtn.onclick = (e) => { e.stopPropagation(); closeLightbox(); };
  titleBar.appendChild(closeBtn);
  dialog.appendChild(titleBar);

  // ── Image area ──
  const imgArea = document.createElement("div");
  imgArea.style.cssText = [
    "flex:1", "display:flex", "align-items:center", "justify-content:center",
    "position:relative", "overflow:hidden", "padding:20px",
  ].join(";");

  const img = document.createElement("img");
  img.src = current.url;
  img.style.cssText = [
    "max-width:100%", "max-height:100%",
    "display:block", "object-fit:contain",
    "border-radius:4px",
  ].join(";");

  // Load dimensions
  img.onload = () => {
    const dims = `${img.naturalWidth}\u00d7${img.naturalHeight}`;
    const existing = subtitle.textContent;
    if (existing === "Loading...") {
      subtitle.textContent = dims;
    }
  };

  // Fetch size + format
  fetch(current.url)
    .then(r => r.blob())
    .then(blob => {
      const size = formatBytes(blob.size);
      const ext = (current.filename.split('.').pop() || '').toUpperCase();
      const existing = subtitle.textContent;
      if (existing && existing !== "Loading...") {
        subtitle.textContent = `${existing} \u00b7 ${size} \u00b7 ${ext}`;
      } else {
        subtitle.textContent = `${size} \u00b7 ${ext}`;
      }
    })
    .catch(() => {
      if (subtitle.textContent === "Loading...") subtitle.textContent = "";
    });

  imgArea.appendChild(img);

  // Nav arrows
  if (lightboxImages.length > 1) {
    const prevBtn = document.createElement("button");
    prevBtn.innerHTML = "\u2039";
    prevBtn.style.cssText = [
      "position:absolute", "left:20px", "top:50%", "transform:translateY(-50%)",
      "width:48px", "height:48px", "border-radius:50%",
      "background:rgba(0,0,0,0.6)", "color:#fff", "font-size:32px",
      "border:2px solid rgba(255,255,255,0.3)", "cursor:pointer",
      "display:flex", "align-items:center", "justify-content:center",
      "z-index:1", "padding-right:4px",
    ].join(";");
    prevBtn.onclick = (e) => { e.stopPropagation(); prevLightbox(); };
    imgArea.appendChild(prevBtn);

    const nextBtn = document.createElement("button");
    nextBtn.innerHTML = "\u203a";
    nextBtn.style.cssText = [
      "position:absolute", "right:20px", "top:50%", "transform:translateY(-50%)",
      "width:48px", "height:48px", "border-radius:50%",
      "background:rgba(0,0,0,0.6)", "color:#fff", "font-size:32px",
      "border:2px solid rgba(255,255,255,0.3)", "cursor:pointer",
      "display:flex", "align-items:center", "justify-content:center",
      "z-index:1", "padding-left:4px",
    ].join(";");
    nextBtn.onclick = (e) => { e.stopPropagation(); nextLightbox(); };
    imgArea.appendChild(nextBtn);

    const counter = document.createElement("div");
    counter.textContent = `${lightboxIndex + 1} / ${lightboxImages.length}`;
    counter.style.cssText = [
      "position:absolute", "bottom:16px", "left:50%", "transform:translateX(-50%)",
      "background:rgba(0,0,0,0.6)", "color:#fff", "font-size:12px",
      "padding:4px 12px", "border-radius:12px",
      "border:1px solid rgba(255,255,255,0.2)",
    ].join(";");
    imgArea.appendChild(counter);
  }

  dialog.appendChild(imgArea);
  document.body.appendChild(dialog);

  const onKey = (e) => {
    if (e.key === "Escape") { closeLightbox(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); prevLightbox(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); nextLightbox(); }
  };
  activeKeyHandler = onKey;
  document.addEventListener("keydown", onKey);
}

function prevLightbox() {
  if (lightboxImages.length <= 1) return;
  lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length;
  renderLightbox();
}

function nextLightbox() {
  if (lightboxImages.length <= 1) return;
  lightboxIndex = (lightboxIndex + 1) % lightboxImages.length;
  renderLightbox();
}

function closeLightbox() {
  if (activeKeyHandler) {
    document.removeEventListener("keydown", activeKeyHandler);
    activeKeyHandler = null;
  }
  const dialog = document.querySelector(".screenshot-paste-lightbox");
  if (dialog) dialog.remove();
}

// ── watch for editor clear ────────────────────────────────────────────────

let sendWatchInstalled = false;

function watchForSend() {
  if (sendWatchInstalled) return;
  sendWatchInstalled = true;
  setInterval(() => {
    if (pendingImages.length === 0) return;
    try {
      const text = getPromptEditor()?.editor?.state?.doc?.toString() ?? "";
      if (text.trim().length === 0) {
        // Editor was cleared — move images to sent for chat thumbnails
        for (const img of pendingImages) {
          sentImages.set(img.filePath, { filename: img.filename });
        }
        pendingImages.length = 0;
        renderThumbnails();
        startChatPoll();
      }
    } catch { /* best effort */ }
  }, 500);
}

// ── toast ──────────────────────────────────────────────────────────────────

function showToast(message, duration = 3000) {
  try {
    let container = document.querySelector(".screenshot-paste-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "screenshot-paste-toast-container";
      container.style.cssText = [
        "position:fixed", "bottom:80px", "left:50%", "transform:translateX(-50%)",
        "z-index:9999", "display:flex", "flex-direction:column", "gap:8px",
        "align-items:center", "pointer-events:none",
      ].join(";");
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.style.cssText = [
      "background:var(--pi-surface,#161b22)", "color:var(--pi-fg,#e6edf3)",
      "border:1px solid var(--pi-border,#30363d)", "border-radius:6px",
      "padding:8px 16px", "font-size:13px", "pointer-events:auto",
      "opacity:0", "transition:opacity 0.2s", "max-width:360px", "text-align:center",
    ].join(";");
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = "1"; });
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 200);
    }, duration);
  } catch { /* best effort */ }
}

// ── core paste logic ───────────────────────────────────────────────────────

let isProcessing = false;

async function doPaste(event) {
  const cd = event.clipboardData;
  if (!cd || !cd.items) return;

  const imageItems = [];
  for (let i = 0; i < cd.items.length; i++) {
    if (cd.items[i].type.startsWith("image/")) imageItems.push(cd.items[i]);
  }
  if (imageItems.length === 0) return;

  event.preventDefault();
  event.stopPropagation();

  if (!serverAvailable) {
    showToast("Paste server not running. Restart pi to start it automatically.", 5000);
    return;
  }

  if (isProcessing) {
    showToast("Already processing an image, please wait\u2026");
    return;
  }
  isProcessing = true;

  try {
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      const processed = await processImage(blob);
      if (!processed) continue;

      const base64 = await blobToBase64(processed.blob);
      if (base64.length > 5_000_000) {
        showToast("Image too large after processing (>5MB), try a smaller screenshot");
        continue;
      }

      const ts = Date.now();
      const rnd = Math.random().toString(36).slice(2, 6);
      const ext = processed.mimeType.split("/")[1] || "png";
      const fileName = `pi-paste-${ts}-${rnd}.${ext}`;

      try {
        const result = await uploadImage(base64, fileName);
        const filePath = result.relativePath;
        const qs = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
        const serverUrl = `${SERVER_URL}/images/${fileName}${qs}`;
        pendingImages.push({ serverUrl, filePath, ts, filename: fileName });

        insertTextAtCursor(`@${filePath} `);
        ensureGitignore();
        renderThumbnails();
      } catch (e) {
        console.error("[screenshot-paste] upload failed:", e);
        showToast("Failed to upload screenshot to server");
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ── paste listener ────────────────────────────────────────────────────────

let handlePaste = null;

// ── plugin export ──────────────────────────────────────────────────────────

const plugin = {
  apiVersion: 1,
  name: "Screenshot Paste",

  activate: ({ html, svg }) => {
    void checkServer();

    if (!handlePaste) {
      handlePaste = (event) => {
        if (!isPasteInPromptEditor(event)) return;
        const pe = event.composedPath().find(
          (el) => el.localName === "prompt-editor" || el.tagName === "PROMPT-EDITOR",
        );
        if (pe) cachedPromptEditor = pe;
        watchForSend();
        void doPaste(event);
      };
      document.addEventListener("paste", handlePaste, true);
    }

    return {
      contributions: {
        actions: [
          {
            id: "paste-screenshot",
            title: "Paste Screenshot",
            description: "Paste a screenshot from clipboard into the chat",
            shortcut: "mod+shift+v",
            group: "Screenshot",
            enabled: (context) => context.state.selectedSession !== undefined,
            run: () => {
              if (!serverAvailable) {
                showToast("Paste server not running. Restart pi to start it automatically.", 5000);
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
                } catch (e) {
                  showToast("Could not read clipboard. Try \u2318V directly in the message box instead.", 5000);
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
            badge: () =>
              pendingImages.length > 0 ? String(pendingImages.length) : undefined,
            render: (context) => {
              workspacePath = context.workspace?.path ?? null;
              void checkServer();
              startPanelPoll();

              const count = pendingImages.length;
              const status = serverAvailable
                ? html`<span style="color:var(--pi-success,#3fb950)">\u25cf Server online</span>`
                : html`<span style="color:var(--pi-error,#f85149)">\u25cf Server offline — restart pi to start</span>`;

              return html`
                <section class="toolbar"><strong>Screenshot Paste</strong> ${status}</section>
                <section class="viewer">
                  <p class="muted">Paste screenshots (\u2318V) in the chat prompt to attach images.</p>
                  <p class="muted">Or use Actions \u2192 Paste Screenshot (\u2318\u21e7V).</p>
                  ${count > 0 ? html`<p style="margin:8px 0 4px;font-size:13px;"><strong>${count}</strong> image(s) staged</p>` : null}
                  <div class="screenshot-paste-panel-gallery"></div>
                  <button @click=${async () => {
                    try {
                      await cleanImages();
                      pendingImages.length = 0;
                      renderThumbnails();
                      stopPanelPoll();
                      startPanelPoll();
                      showToast("All paste images cleaned");
                    } catch (e) {
                      showToast("Clean failed: " + e.message);
                    }
                  }} style="margin-top:8px;padding:4px 12px;background:var(--pi-error-bg);border:1px solid var(--pi-error);color:var(--pi-error);border-radius:4px;cursor:pointer;">
                    \ud83d\udeae Clean all images
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
            visible: () => pendingImages.length > 0,
            items: () => pendingImages.map((img, idx) => ({
              type: "text",
              text: `\ud83d\udcf7 ${idx + 1}`,
            })),
          },
        ],
      },
    };
  },
};

export default plugin;
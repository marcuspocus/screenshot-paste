// @private-api: This plugin accesses the prompt-editor shadow DOM and its
// CodeMirror EditorView instance. These are private/experimental PI WEB surfaces
// that may change shape or disappear across versions. All private API access is
// isolated in clearly-marked functions with fallback error handling.

const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;
const MAX_BASE64_LENGTH = 5_000_000;

// ── state ──────────────────────────────────────────────────────────────────
let currentRuntime = null;
let handlePaste = null;
let cachedPromptEditor = null;
let isProcessing = false;
let activeKeyHandler = null;

const pendingImages = []; // { serverUrl, filePath, ts, filename, w, h, size, mimeType }
const sentImages = [];
const knownImagesByWorkspace = new Map();

function workspaceKey(runtime = currentRuntime) {
  if (!runtime) return "unknown";
  return `${runtime.machineId}:${runtime.projectId}:${runtime.workspaceId}`;
}

function updateRuntimeFromContext(context) {
  const workspace = context?.workspace ?? context?.state?.selectedWorkspace ?? null;
  if (!workspace?.path || !workspace?.projectId || !workspace?.id) return currentRuntime;

  const machine = context?.machine ?? { id: "local", name: "local", kind: "local" };
  const runCommand = context?.terminal?.runCommand
    ? (input) => context.terminal.runCommand(input)
    : context?.piWebUnstable?.terminalCommandRuns?.runCommand
      ? (input) => context.piWebUnstable.terminalCommandRuns.runCommand({ ...input, workspace })
      : currentRuntime?.runCommand;

  currentRuntime = {
    machineId: machine.id ?? "local",
    machineName: machine.name ?? machine.id ?? "local",
    machineKind: machine.kind ?? "local",
    workspace,
    workspacePath: workspace.path,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    runCommand,
  };
  return currentRuntime;
}

function requireRuntime() {
  if (!currentRuntime?.workspacePath || !currentRuntime?.projectId || !currentRuntime?.workspaceId) {
    throw new Error("No active workspace selected. Select a workspace before pasting screenshots.");
  }
  if (typeof currentRuntime.runCommand !== "function") {
    throw new Error("No remote command runtime available yet. Open the Paste panel once, then paste again.");
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

// ── deep DOM query (pierces shadow roots) ──────────────────────────────────
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

// ── pi-web remote-safe file writing / preview ──────────────────────────────
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

function buildWriteCommand({ filename, base64 }) {
  const script = `
const fs = require("fs");
const path = require("path");
const filename = ${JSON.stringify(filename)};
const base64 = ${JSON.stringify(base64)};

fs.mkdirSync(".pi-paste", { recursive: true });
fs.writeFileSync(path.join(".pi-paste", filename), Buffer.from(base64, "base64"));

if (fs.existsSync(".git")) {
  const gitignore = ".gitignore";
  const entry = ".pi-paste/";
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  if (!current.includes(entry)) {
    const prefix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    fs.appendFileSync(gitignore, prefix + entry + "\n");
  }
}

console.log(JSON.stringify({ ok: true, relativePath: ".pi-paste/" + filename, filename }));
`;
  return `node <<'NODE'\n${script}\nNODE`;
}

async function uploadImageToWorkspace(base64, filename) {
  const runtime = requireRuntime();
  const command = buildWriteCommand({ filename, base64 });
  const handle = await runtime.runCommand({
    title: `Save screenshot ${filename}`,
    command,
    open: false,
    metadata: {
      source: "screenshot-paste",
      filename,
    },
  });
  const completed = await handle.completed;
  if (completed.status !== "succeeded" || completed.exitCode !== 0) {
    throw new Error(`Failed to save screenshot in ${runtime.workspacePath}`);
  }
  return {
    relativePath: `.pi-paste/${filename}`,
    filename,
  };
}

// ── prompt-editor interaction (@private-api) ───────────────────────────────
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
    const doc = view.state.doc.toString();
    const variants = [`@${filePath} `, `@${filePath}`, filePath];
    for (const ref of variants) {
      const idx = doc.indexOf(ref);
      if (idx !== -1) {
        view.dispatch({ changes: { from: idx, to: idx + ref.length, insert: "" } });
        view.focus();
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

// ── thumbnails ─────────────────────────────────────────────────────────────
function ensureThumbnailStrip() {
  const existing = document.querySelector(".screenshot-paste-strip");
  if (existing) return existing;

  const editor = getPromptEditor();
  if (!editor) return null;
  const host = editor.parentElement;
  if (!host) return null;

  const strip = document.createElement("div");
  strip.className = "screenshot-paste-strip";
  strip.style.cssText = [
    "display:flex", "flex-wrap:wrap", "gap:8px", "justify-content:center",
    "padding:8px", "margin:6px 0", "border:1px solid var(--pi-border,#30363d)",
    "border-radius:8px", "background:var(--pi-surface,#0d1117)",
  ].join(";");
  host.insertBefore(strip, editor);
  return strip;
}

function renderThumbnails() {
  const strip = ensureThumbnailStrip();
  if (!strip) return;
  strip.innerHTML = "";
  if (pendingImages.length === 0) {
    strip.remove();
    return;
  }

  pendingImages.forEach((img, idx) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = [
      "position:relative", "width:128px", "height:128px", "flex-shrink:0",
      "border-radius:6px", "overflow:hidden", "border:1px solid var(--pi-border,#30363d)",
      "background:var(--pi-border,#30363d)", "cursor:pointer",
    ].join(";");
    const thumb = document.createElement("img");
    thumb.src = img.serverUrl;
    thumb.alt = img.filename;
    thumb.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
    thumb.onclick = () => showLightbox(pendingImages, idx);
    wrapper.appendChild(thumb);

    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Remove from message";
    close.style.cssText = [
      "position:absolute", "top:3px", "right:3px", "width:22px", "height:22px",
      "border-radius:50%", "border:1px solid rgba(255,255,255,.35)",
      "background:rgba(0,0,0,.65)", "color:white", "cursor:pointer", "line-height:18px",
    ].join(";");
    close.onclick = (event) => {
      event.stopPropagation();
      const [removed] = pendingImages.splice(idx, 1);
      if (removed) removeFileRefFromEditor(removed.filePath);
      renderThumbnails();
    };
    wrapper.appendChild(close);
    strip.appendChild(wrapper);
  });
}

function renderPanelGallery() {
  const containers = querySelectorAllDeep(".screenshot-paste-panel-gallery");
  if (containers.length === 0) return;
  const images = currentKnownImages();
  if (images.length === 0) {
    containers.forEach((c) => {
      c.innerHTML = `<p class="muted">No screenshots in this browser session yet. Paste a screenshot (⌘V) to see it here.</p>`;
    });
    return;
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
  containers.forEach((c) => { c.innerHTML = ""; c.appendChild(gallery); });
}

// ── chat thumbnail injection ───────────────────────────────────────────────
function startChatPoll() {
  if (window.__screenshotPasteChatPoll) return;
  window.__screenshotPasteChatPoll = setInterval(injectChatThumbnails, 1500);
}

function injectChatThumbnails() {
  if (!currentRuntime) return;
  const articles = querySelectorAllDeep("article.msg.user");
  for (const article of articles) {
    if (article.dataset.screenshotPasteInjected === "1") continue;
    const text = article.textContent || "";
    if (!text.includes(".pi-paste/")) continue;

    const matches = [...text.matchAll(/(?:@)?(\.pi-paste\/[^\s)\]]+)/g)].map((m) => m[1]);
    if (matches.length === 0) continue;

    article.dataset.screenshotPasteInjected = "1";
    const images = matches.map((filePath) => ({
      filePath,
      filename: filePath.split("/").pop(),
      serverUrl: previewUrl(filePath, currentRuntime),
    }));
    const container = document.createElement("div");
    container.className = "screenshot-paste-inline";
    container.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;justify-content:center;";
    images.forEach((img, idx) => {
      const thumb = document.createElement("img");
      thumb.src = img.serverUrl;
      thumb.alt = img.filename;
      thumb.style.cssText = "width:128px;height:128px;object-fit:contain;background:var(--pi-border,#30363d);border:1px solid var(--pi-border,#30363d);border-radius:6px;cursor:pointer;";
      thumb.onclick = () => showLightbox(images, idx);
      container.appendChild(thumb);
    });
    article.appendChild(container);
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
  if (activeKeyHandler) {
    window.removeEventListener("keydown", activeKeyHandler, true);
    activeKeyHandler = null;
  }
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

// ── toasts ────────────────────────────────────────────────────────────────
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

// ── core paste logic ───────────────────────────────────────────────────────
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
    requireRuntime();
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
      const result = await uploadImageToWorkspace(base64, filename);
      const filePath = result.relativePath;
      const image = {
        serverUrl: previewUrl(filePath, currentRuntime, ts),
        filePath,
        ts,
        filename,
        w: processed.w,
        h: processed.h,
        size: processed.blob.size,
        mimeType: processed.mimeType,
      };
      pendingImages.push(image);
      rememberKnownImage(image);
      insertTextAtCursor(`@${filePath} `);
      renderThumbnails();
      renderPanelGallery();
    }
  } catch (error) {
    console.error("[screenshot-paste] paste failed:", error);
    showToast(error?.message ?? "Failed to paste screenshot", 6000);
  } finally {
    isProcessing = false;
  }
}

function watchForSend() {
  if (window.__screenshotPasteSendWatcher) return;
  window.__screenshotPasteSendWatcher = setInterval(() => {
    const editor = getPromptEditor();
    const text = editor?.editor?.state?.doc?.toString?.() ?? "";
    if (text.trim() === "" && pendingImages.length > 0) {
      sentImages.push(...pendingImages.splice(0));
      renderThumbnails();
      setTimeout(injectChatThumbnails, 800);
    }
  }, 1000);
}

// ── plugin ────────────────────────────────────────────────────────────────
const plugin = {
  apiVersion: 1,
  name: "Screenshot Paste",

  activate: ({ html, svg }) => {
    startChatPoll();

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
            description: "Paste a screenshot from clipboard into the active workspace as an @file image attachment",
            shortcut: "mod+shift+v",
            group: "Screenshot",
            enabled: (context) => {
              updateRuntimeFromContext(context);
              return context.state.selectedSession !== undefined && context.state.selectedWorkspace !== undefined;
            },
            run: (context) => {
              updateRuntimeFromContext(context);
              if (!currentRuntime) {
                showToast("Select a workspace before pasting screenshots.", 5000);
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
              return pendingImages.length > 0 ? String(pendingImages.length) : undefined;
            },
            render: (context) => {
              updateRuntimeFromContext(context);
              queueMicrotask(renderPanelGallery);
              const images = currentKnownImages();
              return html`
                <section class="toolbar"><strong>Screenshot Paste</strong></section>
                <section class="viewer">
                  <p class="muted">Remote-safe mode · ${context.machine.name} · ${context.workspace.path}</p>
                  <p class="muted">Paste screenshots (⌘V) in the chat prompt to save them to <code>.pi-paste/</code> and insert <code>@.pi-paste/…</code>.</p>
                  ${pendingImages.length > 0 ? html`<p style="margin:8px 0 4px;font-size:13px;"><strong>${pendingImages.length}</strong> image(s) staged</p>` : null}
                  ${images.length > 0 ? html`<p class="muted">Showing screenshots pasted in this browser session.</p>` : null}
                  <div class="screenshot-paste-panel-gallery"></div>
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
              return pendingImages.length > 0;
            },
            items: (context) => {
              updateRuntimeFromContext(context);
              return pendingImages.map((img, idx) => ({
                type: "text",
                text: `📷 ${idx + 1}`,
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

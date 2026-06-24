# Agent Guide — @yieldcraft/screenshot-paste

## Project Overview

This is a **pi-web plugin only**. As of **v0.4.0**, its role changed fundamentally:

**pi-web now captures pasted screenshots (⌘V) natively.** pi-web resizes the image, manages the attachment UI in the composer, and either sends it inline (multimodal) or saves it into the workspace at **`.pi-web/paste/`** (folder mode) and inserts `@.pi-web/paste/...` into the prompt.

This plugin **no longer duplicates any of that**. It only adds what pi-web does **not** provide natively:

1. **A navigable gallery** of images saved in `.pi-web/paste/` (a workspace panel).
2. **A fullscreen lightbox** viewer.
3. **Inline `<img>` previews** inside chat **user** messages for folder-mode refs `@.pi-web/paste/...` (pi-web renders inline-mode images natively, but does **not** render folder-mode `@file` references as images — they stay text).
4. **A "clean" action** that deletes the contents of `.pi-web/paste/`.
5. **Idempotent gitignore** of `.pi-web/paste/` (pi-web does not manage gitignore at all).

The plugin is still **remote-safe**:

- no browser `localhost` upload server
- no fixed port
- no absolute `/Users/...` or `/root/...` file references
- it uses pi-web's **stable plugin file API** (`context.files.readFile/writeFile/deleteFile`), which is federated (works local + remote)

---

## Image Flow (v0.4.0+)

```
User pastes image (⌘V) in pi-web chat prompt
    → pi-web captures it NATIVELY (PromptEditor.handlePaste)
    → pi-web resizes + manages attachment chips + inline/folder selector
    → on send:
        inline mode  → pi-web sends binary to pi as ImageContent; ChatView renders <img> natively
        folder mode  → pi-web saves workspace/.pi-web/paste/<file>, inserts @.pi-web/paste/<file>
                     → ChatView shows the @ref as TEXT (no native image render)

This plugin (read-only on the paste flow):
    → Paste panel lists workspace/.pi-web/paste/ via pi-web file tree API
    → gallery thumbnails use pi-web file preview API
    → chat thumbnails: inject <img> into article.msg.user containing @.pi-web/paste/*
    → lightbox: fullscreen viewer over gallery/chat images
    → clean: context.files.deleteFile per entry in .pi-web/paste/
    → gitignore: context.files read/modify/write .gitignore to add .pi-web/paste/
```

## Critical Rules

- The plugin **never** writes screenshot files itself — pi-web owns that. Use `context.files` only for gitignore and the clean action.
- Never exclude `.pi-web/` globally from git — that would untrack `.pi-web/tasks.json`. Only ever add the granular entry **`.pi-web/paste/`**.
- Never insert absolute local paths. Folder-mode refs are `@.pi-web/paste/filename.png`.

---

## What You (the Agent) Can Do With Images

The LLM does **not** see pasted images automatically. When the user asks about a screenshot, use the `read` tool on the relative file path:

```txt
read(".pi-web/paste/filename.png")
```

The file exists in the current workspace (local or remote) because pi-web wrote it through its federated workspace file API.

---

## Helping Users

| User asks | You do |
|---|---|
| "Where are screenshots saved?" | `workspace/.pi-web/paste/` (written by pi-web, not this plugin) |
| "Why can't you see the image?" | Check the chat contains `@.pi-web/paste/...` (folder mode) or that an inline image was sent; use `read(".pi-web/paste/...")` |
| "Paste panel is empty" | Open the Paste panel; check that `.pi-web/paste/` exists in the selected workspace and contains image files (tree API) |
| "Gallery thumbnail broken" | Check pi-web file preview route and that `.pi-web/paste/<file>` exists in the active workspace |
| "I pasted but nothing saved" | pi-web handles paste now — ensure the composer had focus and a workspace is selected; this plugin does not intercept paste |
| "Old staged strip still shows" | That was pre-0.4 behavior; v0.4 has no staged strip (pi-web owns attachment UI). Full-reload pi-web. |
| "Chat images not showing (folder mode)" | This plugin injects them; verify a workspace is selected (runtime tracker) and the user message contains `@.pi-web/paste/` |

---

## Architecture Details

### Browser Plugin (`pi-web-plugin.js`)

Key functions:

- `listPasteImages()` — lists `.pi-web/paste/` via pi-web workspace file tree API (fetch route)
- `galleryImages()` — cached listing with a short TTL, keyed by machine/project/workspace
- `previewUrl(filePath)` — builds the pi-web file preview URL for the active machine/project/workspace
- `renderPanelGallery()` — fills `.screenshot-paste-panel-gallery` containers (Paste panel)
- `cleanPasteImages(context)` — deletes every file in `.pi-web/paste/` via `context.files.deleteFile`
- `ensurePasteGitignored(context)` — idempotently adds `.pi-web/paste/` to `.gitignore` via `context.files` (once per workspace per session)
- `injectChatThumbnails()` — best-effort inline `<img>` previews inside `article.msg.user` / `section.group-msg.user` containing `@.pi-web/paste/...`
- `showLightbox()` / `closeLightbox()` — fullscreen image viewer

State:

- `currentRuntime` — `{ machineId, projectId, workspaceId, workspacePath }` derived from plugin contexts (kept fresh by the panel callbacks and a hidden `workspaceLabels` tracker)
- `galleryCacheByWorkspace` — short-TTL cache of `.pi-web/paste/` listings
- `gitignoredWorkspaces` — set of runtime keys already gitignored this browser session

### APIs used (all stable pi-web plugin API v1)

| Need | API |
|---|---|
| Delete paste files | `context.files.deleteFile(path)` |
| Read `.gitignore` | `context.files.readFile(".gitignore")` |
| Write `.gitignore` | `context.files.writeFile(".gitignore", content)` |
| Runtime info | `context.workspace`, `context.machine` (panel/label contexts) |
| Re-render panel | `context.host.requestRender()` (available if needed) |
| List `.pi-web/paste/` | direct fetch of the workspace `tree` route (no `listDir` in the plugin file API) |
| Image preview | direct fetch of the workspace `file/preview` route |

### @private-api surfaces (best-effort, isolated)

- `injectChatThumbnails()` walks the DOM and pierces the `chat-view` shadow root to find user messages. There is **no** plugin API for chat access. This is the only remaining private-API surface and is clearly marked in the code.
- Panel gallery is filled imperatively via `queueMicrotask` after lit render (same pattern as before; lit re-renders re-trigger the microtask).

---

## File Structure

```txt
screenshot-paste/
├── pi-web-plugin.js              # Browser plugin loaded by pi-web
├── package.json                  # npm package + piWeb.plugins metadata
├── .pi-web/tasks.json            # Public-safe workspace tasks
├── docs/tmp/pi-web-api-analysis.md  # API analysis that drove the v0.4 refactor
├── README.md
└── AGENTS.md
```

There is intentionally no pi extension and no HTTP server.

---

## Public vs Internal Files

Public-safe files:

- `README.md`
- `AGENTS.md`
- `package.json`
- `package-lock.json`
- `pi-web-plugin.js`
- `.pi-web/tasks.json`
- `docs/`
- `.github/workflows/release.yml` for the clean GitHub snapshot

Internal-only files:

- `.forgejo/`
- `tools/scripts/`
- `.pi-web/paste/` (runtime screenshots — gitignored)
- `.npmrc`
- private registry URLs, Forgejo package URLs, tokens, or private hostnames

Before syncing to GitHub or publishing to npmjs, use an allowlist and anti-leak scan. Do not mirror the private Forgejo repository directly to GitHub.

---

## Git & Release Rules

**CRITICAL:** Never commit, push, tag, or npm publish without explicit user confirmation.

- Always show status/diff first when unsure
- Wait for user confirmation (`go`, `oui`, `commit`, `push`, `publish`, etc.)
- This applies to commit, push, tag, `npm version`, and `npm publish`

Release topology:

- private source repo may keep full development history
- public GitHub repo should receive clean snapshots only
- npmjs public releases should use Trusted Publishing after GitHub sync
- internal registry test publishes may use plain `npm publish` in developer environments

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Gallery empty | `.pi-web/paste/` missing/empty, wrong selected workspace, or tree API failed | Verify selected machine/workspace; paste a screenshot first (pi-web saves it) |
| Chat images missing (folder mode) | No workspace selected (runtime tracker cold) or message has no `@.pi-web/paste/` ref | Open the Paste panel once / select a workspace; confirm folder delivery mode |
| `.gitignore` not updated | `context.files` unavailable or workspace not a git repo | Plugin adds `.pi-web/paste/` lazily on first panel render; check `context.files` |
| Old staged strip / pending chips reappear | Pre-0.4 plugin still loaded in memory | Full-reload pi-web to load v0.4 |
| Agent cannot read image | Wrong cwd or missing `.pi-web/paste/<file>` | Verify file exists in current workspace via the Paste panel |
| Old absolute `/Users/...` path behavior | Pre-remote-safe version (<0.2.2) | Upgrade to `>=0.4.0` |

---

## License

MIT © YieldCraft
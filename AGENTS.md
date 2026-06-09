# Agent Guide — @yieldcraft/screenshot-paste

## Project Overview

This is a **pi-web plugin only**. It lets users paste screenshots (⌘V) into the pi-web chat prompt. Images are saved into the active workspace at `.pi-paste/` and referenced as `@.pi-paste/...` attachments.

The plugin is intentionally **remote-safe**:

- no browser `localhost` upload server
- no fixed port
- no absolute `/Users/...` or `/root/...` file references
- all saved images live in the selected pi-web workspace

---

## Remote-Safe Image Flow

```
User pastes image (⌘V)
    → pi-web-plugin.js intercepts paste event in browser
    → browser resizes/compresses image (max 1600px)
    → plugin uses pi-web workspace terminal runtime
    → command runs on selected machine (local or remote)
    → writes workspace/.pi-paste/filename.ext
    → appends .pi-paste/ to .gitignore when workspace is a git repo
    → inserts @.pi-paste/filename.ext at cursor
    → staged thumbnails use pi-web file preview API for the selected machine/workspace
    → Paste panel lists workspace/.pi-paste/ through pi-web file tree API
    → gallery/history thumbnails use pi-web file preview API
```

## Critical Rule

Never insert absolute local paths such as:

```txt
@/Users/marcus/.pi-paste/...
@/root/.pi-paste/...
```

Those break remote agents. Only insert relative workspace paths:

```txt
@.pi-paste/filename.png
```

---

## What You (the Agent) Can Do With Images

The LLM does **not** see pasted images automatically. When the user asks about a screenshot, use the `read` tool on the inserted relative file path:

```txt
read(".pi-paste/filename.png")
```

The file should exist in the current workspace, including remote workspaces, because the plugin writes through pi-web's selected machine runtime.

---

## Helping Users

| User asks | You do |
|---|---|
| "Where are screenshots saved?" | `workspace/.pi-paste/` |
| "Why can't you see the image?" | Check the chat contains `@.pi-paste/...`, not an absolute path |
| "Paste panel is empty" | Check that `.pi-paste/` exists in the selected workspace and contains image files; the panel lists workspace files via pi-web's file tree API |
| "Thumbnail broken" | Check pi-web file preview route and that `.pi-paste/file` exists in the active workspace |
| "Remote paste broken" | Verify package version is remote-safe (`>=0.2.2`) and pi-web selected machine/workspace is correct |

---

## Architecture Details

### Browser Plugin (`pi-web-plugin.js`)

Key functions:

- `processImage(blob)` — resize/compress via canvas
- `uploadImageToWorkspace(base64, filename)` — writes via pi-web terminal command runtime
- `buildWriteCommand()` — creates the remote Node.js command that writes `.pi-paste/`
- `listWorkspacePasteImages()` — lists `.pi-paste/` via pi-web workspace file tree API
- `previewUrl(filePath)` — builds pi-web file preview URL for active machine/project/workspace
- `insertTextAtCursor(text)` — inserts `@.pi-paste/...` in CodeMirror prompt
- `renderThumbnails()` — staged thumbnails above editor
- `renderPanelGallery()` — workspace `.pi-paste/` gallery in Paste panel
- `injectChatThumbnails()` — best-effort chat history thumbnails using a separate history strip
- `cleanWorkspacePasteImages()` — deletes files inside active workspace `.pi-paste/` through the workspace runtime
- `showLightbox()` — fullscreen image viewer

State:

- `currentRuntime` — selected machine/workspace/project and command runtime
- `pendingImages` — images staged in current prompt
- `knownImagesByWorkspace` — browser-session cache for freshly pasted images, keyed by machine/project/workspace; the Paste panel also reads `.pi-paste/` from disk

---

## File Structure

```txt
screenshot-paste/
├── pi-web-plugin.js              # Browser plugin loaded by pi-web
├── package.json                  # npm package + piWeb.plugins metadata
├── .pi-web/tasks.json            # Public-safe workspace tasks
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
- `.github/workflows/release.yml` for the clean GitHub snapshot

Internal-only files:

- `.forgejo/`
- `tools/scripts/`
- `.pi-paste/`
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
| Absolute `/Users/...` path inserted | Old pre-remote-safe version | Upgrade to `>=0.2.2` |
| Paste says no workspace selected | pi-web has no active workspace context | Select a workspace/open Paste panel once |
| Save command fails | Node missing on selected machine | Install Node.js on the remote machine |
| Gallery empty | `.pi-paste/` missing/empty, wrong selected workspace, or pi-web file tree API failed | Verify selected machine/workspace and inspect `.pi-paste/` in Files |
| Agent cannot read image | Wrong cwd or missing `.pi-paste` file | Verify file exists in current workspace |

---

## License

MIT © YieldCraft

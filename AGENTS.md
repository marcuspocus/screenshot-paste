# Agent Guide — @yieldcraft/screenshot-paste

## Project Overview

This is a **pi-web plugin + pi extension** that lets users paste screenshots (⌘V) directly into the chat prompt. Images are saved to `workspace/.pi-paste/` and referenced as `@file` attachments.

**Two components work together:**

1. **pi-web plugin** (`pi-web-plugin.js`) — Browser-side code that intercepts paste events, shows thumbnails, and manages the gallery
2. **pi extension** (`.pi/extensions/screenshot-paste/index.ts`) — Node.js server that auto-starts on port 9876 when pi launches

**Communication:** Browser ↔ `localhost:9876` (HTTP)

---

## How Images Flow

```
User pastes image (⌘V)
    → pi-web-plugin.js intercepts paste event
    → Resizes image (max 1600px, PNG vs JPEG 85%)
    → Base64 upload POST /upload → Node.js server
    → Server saves to workspace/.pi-paste/filename.ext
    → Plugin inserts @.pi-paste/filename.ext at cursor
    → Thumbnail appears in strip above editor
    → Thumbnail appears in Paste panel gallery
```

**When message is sent:**
- Thumbnails move from "staging" strip to chat history (injected under the user message)
- The @file reference is in the text — pi-web processes it client-side

---

## What You (the Agent) Can Do With Images

### Reading Images

The LLM (you) **cannot** see images automatically. pi-web replaces image content with a text placeholder before sending to the LLM. To actually see the image, you must:

1. **Use the `read` tool** on the file path when the user asks about an image
2. The `read` tool supports images — it will show you the image content

**Example:**
```
User: "What do you see in this screenshot?" [with @.pi-paste/xxx.png in text]
Agent: read(".pi-paste/xxx.png") → shows image → describe it
```

### Helping Users

| User asks | You do |
|---|---|
| "Why isn't paste working?" | Check server health: `curl http://localhost:9876/health` |
| "Clean my paste images" | Run the Clean task or `curl -X DELETE http://localhost:9876/clean` |
| "Where are my images saved?" | `workspace/.pi-paste/` (relative to current workspace) |
| "The thumbnail is broken" | Check if server is running; images are served from `localhost:9876/images/filename` |
| "Can I navigate images?" | In lightbox: click arrows or use ← → keys. Escape to close. |

---

## Architecture Details

### Server API (localhost:9876)

| Endpoint | Purpose |
|---|---|
| `POST /upload` | Save base64 image. Body: `{base64, filename, workspace}` |
| `GET /images?workspace=` | List all images for a workspace |
| `GET /images/:filename?workspace=` | Serve raw image bytes |
| `DELETE /clean?workspace=` | Delete all images for a workspace |
| `GET /health` | Health check |

### Browser Plugin (pi-web-plugin.js)

**Key functions:**
- `processImage(blob)` — resizes image via canvas, chooses PNG vs JPEG
- `uploadImage(base64, filename)` — POST to server
- `insertTextAtCursor(text)` — inserts @file ref at cursor position
- `renderThumbnails()` — builds thumbnail strip above prompt-editor
- `startPanelPoll()` — polls `/images` every 2s to update gallery
- `startChatPoll()` — polls for user messages to inject chat thumbnails
- `showLightbox(images, index)` — fullscreen dialog with nav

**State:**
- `pendingImages` — images currently in the editor (staging)
- `sentImages` — images that have been sent (for chat injection)
- `lightboxImages` — array for lightbox navigation

---

## File Structure

```
screenshot-paste/
├── pi-web-plugin.js              # Browser plugin (loaded by pi-web)
├── server.mjs                    # Standalone dev server
├── package.json                  # npm package + piWeb.plugins metadata
├── .pi-web/tasks.json            # Workspace tasks for pi-web Tasks panel
├── .pi/
│   └── extensions/
│       └── screenshot-paste/
│           └── index.ts          # pi extension (auto-starts server)
└── .gitignore                    # Excludes .pi-paste/
```

---

## Development Tasks (from .pi-web/tasks.json)

| Task | Command | Purpose |
|---|---|---|
| Server Start | `node server.mjs` | Manual dev server start |
| Server Stop | `kill $(lsof -ti:9876)` | Kill server |
| Server Restart | stop + start | Reload server |
| Server Clean | `curl -X DELETE localhost:9876/clean` | Wipe all images |
| Server Status | `curl localhost:9876/health` | Check if running |
| Dev Link | `npm run dev:link` | Symlink into ~/.pi-web/plugins/ |
| Dev Unlink | `npm run dev:unlink` | Remove symlink |

---

## Git & Release Rules

**CRITICAL:** Never commit, push, tag, or npm publish without explicit user confirmation.

- Always show the diff/status first
- Wait for user to say "oui", "go", "commit", "push", "publish", or similar
- This applies to all mutating operations: commit, push, tag, npm version, npm publish

**Two remotes:**
- `origin` — Forgejo (private, full history)
- `github` — GitHub public (clean, squashed history)

**Release flow:**
1. Commit on `main`
2. Push to Forgejo first (preserves history)
3. Squash to `clean` branch, force-push to GitHub
4. Tag `vX.Y.Z` on both
5. `npm publish` (scope: @yieldcraft)

---

## Public vs Internal Files

This repository is developed in a private Forgejo repo but published publicly to GitHub and npmjs.

**Public-safe files:**
- `README.md`
- `AGENTS.md`
- `package.json`
- `pi-web-plugin.js`
- `server.mjs`
- `.pi-web/tasks.json` (public/dev-safe tasks only)
- `.pi/extensions/screenshot-paste/index.ts`

**Internal-only files:**
- `.forgejo/`
- `.forgejo/release-tasks.json`
- `.pi-paste/`
- `.npmrc`
- anything containing private registry URLs, Forgejo package URLs, private hostnames, or release credentials

Before publishing to npmjs or syncing to GitHub, use an allowlist. Do not mirror the private Forgejo repository directly to GitHub.

---

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| "Paste server not running" | Server not started | Restart pi (extension auto-starts) or run `node server.mjs` |
| Thumbnails don't appear in chat | Chat polling missed the message | Normal — chat injection is best-effort via polling |
| Gallery is empty | Panel not opened since last image | Open Paste panel, it polls every 2s |
| Broken image icon | Server can't find image | Server searches `~/.pi-paste/` and `workspace/.pi-paste/` — check path |
| Arrow keys stuck in lightbox | Old keyboard listener not removed | Close lightbox (Escape or X), re-open |

---

## License

MIT © YieldCraft

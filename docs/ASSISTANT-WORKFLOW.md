# LocalAssistant - the whole workflow

This is the one document that covers what to copy where, how to build the index,
how updates work, how the widget picks up a site's colors, and what happens on
browsers that cannot run WebGPU.

The assistant is a static bundle plus two data files. There is no server-side
component and no API key. Answers are produced on the visitor's device from an
index of the site's own pages.

## What ships where

```
<site>/assistant/
  runtime/                  the product build (replace this folder to upgrade)
    loader.js               the one file every page loads
    widget.js, widget.css   the launcher, panel, and styles
    dashboard.html          the ingest page (owner tool)
    vendor/                 the in-browser model engines
  assistant.config.json     site settings (name, greeting, accent, model)
  assistant-index.json      indexed chunks + page titles
  assistant-index.bin       one vector per chunk
```

`runtime/` is disposable - replacing it upgrades the assistant. The config and
the two index files sit outside it and survive an upgrade. The WordPress plugin
keeps the same layout inside the plugin folder and stores the index in
`wp-content/uploads/`.

## Static site install

Do these in order; each step has a check you can run.

1. **Copy the bundle.** Copy `product/dist/` to `<site>/assistant/runtime/`.
   *Check:* `https://<site>/assistant/runtime/loader.js` returns the file.
2. **Add the config.** Copy `product/dist/assistant.config.json` to
   `<site>/assistant/assistant.config.json` and set `siteName`, `assistantName`,
   `greeting`, and (optionally) `accent`. The `indexPath` may stay `./assistant-index`
   - it resolves against the config file, not the page, so it works from any depth.
3. **Add the loader tag to every page.** One line, before `</body>`:

   ```html
   <script type="module" src="/assistant/runtime/loader.js" data-assistant
     data-config="/assistant/assistant.config.json"></script>
   ```

   *Check:* the gold "AI CHAT" pill appears in the lower-right corner. (A
   generator such as `build.py` should append this line itself.)
4. **Serve over HTTP(S).** Modules and workers do not run from `file://`, and the
   model needs a secure context: `https://` or `localhost`. A plain-HTTP LAN
   address works for browsing but the assistant stays hidden by design.
5. **Build the index** (next section). Until the two index files exist, the widget
   reports that the site index could not load.

## The ingest page

The ingest page is `assistant/runtime/dashboard.html` - it lives inside the site
folder, so the site is its own source and there is no CORS setup.

1. Open `https://<site>/assistant/runtime/dashboard.html` in Chrome or Edge.
2. Enter the site URL (for example `https://example.com/`) and press **Build index**.
3. Wait for the report: it shows chunks, pages, vector size, and any skipped pages.
   The first run downloads the 23 MB search model; later runs reuse it.
4. Save the two downloads as `<site>/assistant/assistant-index.json` and
   `<site>/assistant/assistant-index.bin`, replacing the old files.
5. Reload the site twice. The first load may still show the previous index; the
   second uses the new one.

The dashboard is an owner tool: it crawls the site and hands you the files. Do not
link it from navigation. It does not upload anything except when the WordPress
plugin's **Save to WordPress** button is used.

**Do not let localhost URLs into the index.** If you ingest through a local
server, page URLs come back as `http://127.0.0.1:.../...`; rewrite them to
site-relative paths (`/section/page.html`) before uploading, or every citation
will point at your own machine. The dashboard built into this repo does not
rewrite them for you.

## WordPress install

1. Build the plugin: `npm run build` produces `dist/wordpress/` (plugin folder with
   the whole `dist/` inside). Zip that folder.
2. In wp-admin: **Plugins -> Add New -> Upload Plugin**, install, activate.
3. Go to **Settings -> Local Assistant**.
4. Enter the site URL and press **Build index**, then **Save to WordPress**. The
   index lands in `wp-content/uploads/local-assistant/`; no file copying needed.
5. The widget appears on the front end automatically (the plugin enqueues the
   loader on non-admin pages). The **Fallback accent color** field configures the
   color used only when the theme exposes none of its own.

If the admin page reports the `dist` folder is missing, the plugin was built before
`npm run build` was run - rebuild and reinstall.

## Updating

| What changed | What to replace |
|---|---|
| Widget code | `assistant/runtime/` only |
| Site content | Re-run ingest, replace the two index files |
| Site name / greeting / accent | `assistant.config.json` |
| Chat model | Config `model`, plus matching weights and wasm in the runtime |

After any replacement, load the site twice so the background caches settle.

## Colors

The widget reads the page it is embedded in: background, text, and the first
accent token it can find (`--el-accent`, `--accent`, `--brand`, `--primary`, ...).
The panel, bubbles, borders, buttons, and the launcher pill are derived from those
three readings and their contrast is corrected, so a dark site gets a dark panel
and a warm paper site gets a warm one. `accent` in the config is only the fallback
for pages that publish no color of their own - the widget does not need site-
specific CSS.

## Browsers, and the fallback

The written assistant needs WebGPU (a browser feature that exposes the graphics
card) and about 200 MB of one-time model download. Support as of late 2026:

| Browser | Written answers | Notes |
|---|---|---|
| Chrome / Edge, Windows & macOS | Yes, default since 113 | |
| Chrome on Linux | Partly | Intel Gen12+ default (144+); NVIDIA needs Wayland (147+) |
| Brave | Partly | Usually off on Linux; a flag may enable it, may still fail |
| Firefox | Partly | Windows/macOS builds; Linux is limited; Android has none |
| Safari / iOS | Yes, Safari 26+ | Older iOS versions do not |
| Phones (Android) | Partly | Recent Chrome only; older devices fall back |

When WebGPU is missing or unusable - including the common case of a software
adapter that cannot compile the model's shaders - the widget does **not** show a
raw engine error. It shows a short card explaining what is missing, with steps to
fix it on that browser, a link to `webgpureport.org`, a **Check again** button, and
**Use search fallback**.

**Search-only mode** needs no GPU and no model: it uses the same 23 MB embedder to
find the closest page and quotes that passage verbatim, with the usual source
links. It is offered automatically on failure and is the intended path for
Firefox on Linux, older phones, and locked-down desktops. A visitor in that mode
is never asked for the 200 MB model download.

If the model writes something the grounding check cannot verify, the widget does
not simply refuse: it keeps the better of two attempts when the text is
substantially built from the pages, and otherwise quotes the closest passage.
A hard "not covered" answer is reserved for pages that genuinely do not contain
the topic.

## Troubleshooting

- **The pill is missing** - check the loader tag, then the browser console. From
  `file://` this is expected; modules are blocked.
- **"Site index could not load"** - the config's `indexPath` and the two files
  disagree, or the index was never ingested.
- **"This browser can't run the assistant"** - WebGPU is absent. Use **Search the
  pages instead**, or follow the steps on the card.
- **Old answers after an update** - load twice; the service worker serves cached
  assets once and refreshes behind the page.
- **Offline mode** - the cache only covers URLs inside the service worker's
  scope. To cache whole pages, register it at the site root with a
  `Service-Worker-Allowed: /` header and `data-scope="/"` on the loader tag;
  otherwise offline mode covers the assistant's own files only.

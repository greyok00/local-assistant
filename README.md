![Grey Local Site AI Assistant](docs/images/banner-1544x500.png)

# Grey Local Site AI Assistant

Grey Local Site AI Assistant puts a chat button on your site that answers
questions from your own pages — and does the work in the visitor's browser.
There is no server, no API key, and no question ever leaves the device. Every
answer names the page it came from, and when the pages do not contain the
answer it says so instead of inventing one.

**Version 0.3.14** · Static sites and WordPress · GPL-2.0-or-later

## What the visitor gets

A small button in the bottom-right corner. Opening the panel starts the
install automatically — there is no separate consent step. After that the
models stay cached on their device, so the assistant works on every page of
the site and keeps working offline.

![The builder page: Build, Install, Settings and FAQ on one tab strip](docs/images/index-builder.png)

## What happens when a question is asked

The pipeline is short and local. Understanding it is the difference between
"it usually works" and knowing why a particular answer came out the way it did.

1. **Read the index.** At build time the site is crawled from its sitemap (up
   to `maxPages`, 500 by default) and split into overlapping passages — 180
   words with 40 words of overlap, each prefixed with its section heading. One
   small embedding model, `all-MiniLM-L6-v2`, turns every passage into a
   384-dimension vector. The result is two files: the vectors and their
   metadata.
2. **Retrieve.** The question is embedded the same way, then scored against
   every passage with cosine similarity plus a keyword-overlap bonus. The top
   `topK` passages (6 by default) are kept.
3. **Refuse, if the evidence is thin.** The best passage must score at least
   `relevanceThreshold` (0.35) *and* contain at least two of the question's
   content words — or its only word, for a one-word question. Embeddings find
   topical neighbours, not answers, so a question about the weather can score
   0.49 against a page that mentions the city once; the word check is what
   stops that. If nothing survives, the visitor gets the closest pages as
   suggestions instead of a made-up answer.
4. **Generate.** On a browser with WebGPU, `SmolLM2-360M-Instruct` runs on the
   GPU. On one without it, a smaller `SmolLM2-135M-Instruct` runs in a Web
   Worker on the CPU, so the page never freezes while it thinks.
5. **Ground the answer.** The model is told to answer only from the numbered
   notes, to cite the note number in brackets, and to reply `NOT_COVERED`
   rather than guess. The reply is checked against the passages afterwards; a
   weak answer gets one clean retry, and a refusal is shown as a refusal.
6. **Show the source.** The citation names the page, and the answer's first
   line stays attached to it rather than buried under a list of links.

The page text is treated as data throughout. Bracketed numbers and "Note N"
are stripped from a passage before the model sees it, and the system prompt
frames every passage as data rather than instructions — so a page that says
"[2]" or "Note 2" cannot promote itself above the real sources.

## What it costs

The index is small — two files of text and vectors. The models are the weight:
the GPU model and its embedder are roughly 225 MB at first load; the CPU model
is smaller. Both stay cached on the device after the first load, so a returning
visitor downloads nothing. The widget and the index are precached by the
service worker, which is why the assistant survives a dropped connection.

Questions, passages, and answers are never sent anywhere. The only third-party
requests are for the model files, and those can be self-hosted if a deployment
forbids them — see the Settings section below.

## Install on a static site

1. Download `local-assistant-0.3.13-static.zip` from Releases and unpack it.
2. Copy the `local-assistant-0.3.13/` folder to your site, for example as
   `/assistant/`. It is already built; the folder is about 37 MiB, most of it
   the vendored model runtimes.
3. Add this line before `</body>` on every page you want the button on:

   ```html
   <script type="module" src="/assistant/loader.js" data-assistant></script>
   ```

4. Open `/assistant/dashboard.html`, enter your site's URL, and press
   **Build index**.
5. Download the two index files and upload them beside the assistant as
   `assistant-index.json` and `assistant-index.bin`. If you install the files
   elsewhere, set `indexPath` in the Settings tab to match.

## Install on WordPress

1. Download `grey-local-site-ai-assistant-0.3.13-wordpress.zip`.
2. **Plugins → Add New → Upload Plugin**, choose the ZIP, then activate it.
3. Open **Settings → Local Assistant**. The same four tabs as the static page
   are there: Build, Install, Settings, FAQ.
4. On the **Build** tab, press **Build index**. The plugin saves the result to
   `wp-content/uploads/local-assistant/` for you.
5. The button appears on every public page; no theme edit is needed.

![The WordPress page: the same four tabs inside wp-admin](docs/images/wordpress-settings.png)

## Build the index

Both installs work the same way: the index is built in your browser from the
site's own pages.

1. Enter the site URL on the **Build** tab. The builder reads the sitemap.
2. Press **Build index** and leave the tab open. The progress bar shows pages
   read and passages embedded.
3. When it finishes, save the index. On a static site you download two files; on
   WordPress the plugin stores them for you.
4. Rebuild when you add or change pages that matter. The old index keeps
   working until you replace it.

A page that is not in the sitemap is not in the index, and a page behind a
login is never read — the assistant runs in the visitor's browser and only sees
what a visitor can open.

## The four tabs

| Tab | What it is for |
|---|---|
| Build | Enter the site URL, build the index, see progress |
| Install | The script tag for static sites, the plugin steps for WordPress |
| Settings | Assistant name, greeting, answer limits, model paths |
| FAQ | Eight answers, collapsed until opened |

## The widget dresses itself

This is the part visitors notice. The widget reads the page it sits on and
derives its panel, transcript, borders, muted text, and label colour from the
page's own tokens — background, text, panel and accent custom properties, then
`<meta name="theme-color">`. It keeps listening: flipping a light/dark toggle
repaints the open panel without a reload. Contrast is enforced rather than
assumed, so a mid-grey accent is nudged until its label clears 4.5:1. The
`accent` setting is only the default for a page that publishes no colour at
all.

## Settings

The static build reads `assistant.config.json`; the WordPress plugin stores the
same keys in its options.

| Key | Default | What it changes |
|---|---|---|
| `assistantName` | `AI Assistant` | Title on the widget |
| `greeting` | `Ask about the pages on this site` | Input placeholder |
| `indexPath` | `/assistant-index` | Where the two index files live |
| `relevanceThreshold` | `0.35` | Below this score — or when a passage lacks enough of the question's own words — the assistant declines instead of guessing |
| `topK` | `6` | Passages given to the answer model |
| `maxAnswerWords` | `120` | Longest answer |
| `maxPages` | `500` | Pages read in one build |
| `accent` | `#e8622c` | Used only when the page exposes no colour |
| `modelBaseUrl` | `""` | Where the chat model weights come from |
| `modelMirror` | `""` | Self-hosted copy of the model files |

## If the button does not appear

- **The script tag is missing or points at the wrong path.** View source and
  check that `/assistant/loader.js` loads; the browser console names the 404.
- **The site is not on HTTPS.** Browsers only run the models on a secure
  origin. `localhost` counts as secure for testing.
- **The index was never built.** The button still appears, but every answer says
  nothing relevant was found.
- **The page is behind a login.** The assistant runs in the visitor's browser,
  so it only sees pages a visitor can open.

## Requirements

- HTTPS in production. Browsers require a secure origin for the models and the
  service worker; `localhost` is fine for testing.
- Any current browser, desktop or phone. Where WebGPU is available the model
  runs on the GPU; a browser without it answers with the smaller CPU model.
- The first visit downloads the models once. The GPU model and its embedding
  model are about 225 MB together; the CPU model is smaller.

## Development

```
cd product
npm ci
npm run build     # rebuild dist/ and dist/wordpress/
npm test          # 171 tests
npm run release   # versioned static and WordPress zips + SHA256SUMS
```

`src/` is the source; `dist/` is generated and never edited by hand. The build
minifies and strips comments, and the release script refuses to ship source
maps, absolute home paths, email addresses, or token-shaped strings.

## Documentation

- [Settings](#settings) — the full configuration list, including
  model hosting and self-hosting
- [`product/docs/ASSISTANT-WORKFLOW.md`](docs/ASSISTANT-WORKFLOW.md) — how an index is built and used
- [`product/docs/RELEASE-NOTES-0.3.0.md`](docs/RELEASE-NOTES-0.3.0.md) — the 0.3 series

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

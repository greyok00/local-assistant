# LocalAssistant — a site assistant that runs in the visitor's browser

The assistant answers questions using only the pages you have ingested, and it does the
work on the visitor's device. There is no server to run, no API key, and no text ever leaves
the browser: retrieval runs on the CPU with a small embedding model, and the answer is
generated on the GPU with WebGPU. On a browser that has no WebGPU — an older Firefox or
Safari, a machine whose driver is blocked, one that declines the adapter — the same widget
answers with a smaller model running on the CPU instead.

A visitor sees a small chat button in the bottom-right corner. Opening the panel starts
the install automatically — there is no separate consent step; after that the models stay
cached on their device, so the assistant works on every page of the site and keeps working
offline.

## What you need

- A site you can add a file to: any static host, or WordPress with an admin account.
- HTTPS in production. WebGPU and service workers require a secure origin; `localhost` is
  also treated as secure for testing.
- Any modern browser. Chrome/Edge 113+, Safari 18+ and Firefox 141+ run the model on the
  GPU with WebGPU; everywhere else the compatibility model runs on the CPU, and a visitor
  whose browser can do neither still gets quoted passages through the search fallback.

## Install — static site

1. Unpack the archive and copy the `local-assistant-<version>/` folder to your site, for
   example as `/assistant/`. It is already built — the JavaScript is minified, the model
   runtimes are vendored, and the folder is about 37 MiB, most of it those runtimes.
   (Maintainers build it from source with `npm ci && npm run build`.)
2. Paste this one line where the assistant should appear, usually just before `</body>`:

   ```html
   <script type="module" src="/assistant/loader.js" data-assistant></script>
   ```

   Add `data-config="/assistant/assistant.config.json"` if your config lives elsewhere.
3. Open `/assistant/dashboard.html`, enter your site's URL, press **Build index**, then
   download the two files.
4. Upload them next to the assistant, named `assistant-index.json` and `assistant-index.bin`
   (or wherever `indexPath` points).

The dashboard is a plain page: it stays in the folder you uploaded it to and needs no
server, CLI, or build step of its own. It does need to be served by the site over
HTTP(S) — opening `dashboard.html` from a `file://` URL fails, because module scripts
and the crawl's fetches don't run from file origins.

## Install — WordPress

1. Unpack `local-assistant-<version>-wordpress.zip` into
   `wp-content/plugins/local-assistant/`.
2. Activate **Local Assistant** in Plugins.
3. Open **Settings → Local Assistant**, press **Build index**, wait for the progress bar,
   then press **Save index**. The plugin writes the artifact to
   `wp-content/uploads/local-assistant/` and serves the configuration over REST.

The widget then appears on every page. No theme edit is needed.

## Configuration

`assistant.config.json` holds the same keys in both installs; the WordPress plugin edits
them in the settings screen. The example file is `src/config.example.json`.

| Key | Default | Meaning |
|---|---|---|
| `siteName` | `This site` | Used in the index metadata |
| `assistantName` | `AI Assistant` | Widget title |
| `greeting` | `Ask about the pages on this site` | Input placeholder |
| `indexPath` | `/local-assistant/assistant-index` | Stem of the two index files |
| `model` | `SmolLM2-360M-Instruct-q4f16_1-MLC` | Chat model served by WebLLM |
| `cpuModel` | `HuggingFaceTB/SmolLM2-135M-Instruct` | Chat model used when WebGPU is absent |
| `cpuDtype` | `int8` | Weight format for `cpuModel` (`int8` → `model_int8.onnx`) |
| `embedder` | `Xenova/all-MiniLM-L6-v2` | 384-dimension embedding model |
| `relevanceThreshold` | `0.35` | Below this score the assistant refuses instead of guessing |
| `topK` | `6` | Passages given to the chat model |
| `maxAnswerWords` | `120` | Answer length limit |
| `accent` | `#e8622c` | Fallback accent when the page exposes no colour of its own |
| `maxPages` | `500` | Crawl limit while indexing |
| `modelBaseUrl` | `""` | Where model weights come from |
| `modelLibUrl` | `""` | Where the model's compiled wasm comes from |
| `modelMirror` | `""` | Self-hosted copy of the Hugging Face models, laid out as `<org>/<model>/<file>` |

## Theme

The widget reads the host page and dresses itself in its palette: the page background, its
text colour, its panel colour when it names one (`--el-panel`, `--surface`, `--panel`,
`--card-bg`, …), and its accent token (`--el-accent`, `--accent`, `--primary`, `--brand`, …,
then `<meta name="theme-color">`). From those it derives the panel, transcript, borders,
muted text, and a label colour that stays legible on the accent. `accent` in the config is
only the fallback for pages that publish no colour at all.

The widget keeps listening: flipping a light/dark toggle — a `data-theme` attribute, a class
on `<html>` or `<body>`, or a swapped stylesheet — repaints the open panel without a reload.
Contrast is enforced rather than assumed, so a mid-grey accent is nudged until its label
clears 4.5:1 and unreadable page text is replaced.

## Third-party requests and strict self-hosting

The assistant's own code and the index are served entirely from your site. With the model
keys empty, the MiniLM embedder, the chat model's weights, and its compiled wasm come from
the official Hugging Face and GitHub endpoints — this is what makes the first load work
without you hosting 225 MB. A deployment that forbids third-party requests must mirror
everything, then set:

```json
{
  "modelBaseUrl": "/assistant/models",
  "modelLibUrl": "/assistant/models/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm"
}
```

The weights directory must contain the files WebLLM expects for the model
(`mlc-chat-config.json`, tensor shards, tokenizer files) under
`<modelBaseUrl>/<model>/`.

The MiniLM embedder (the search model) and the CPU chat model come from the
public Hugging Face CDN
by default, which is slow enough (about 430 KB/s here) to make a first visit
feel broken. `modelMirror` points them at a copy on your own site instead:
the directory holds `<org>/<model>/<file>` for each model, and the files are
loaded over the same connection as the page.

```json
{ "modelMirror": "/assistant/models/hf/" }
```

## Which engine runs

The widget walks a chain and stops at the first rung that works:

1. **WebGPU.** WebLLM runs the 360M model on the GPU. About 3.5 s from a warm cache on a
   laptop GPU, and the first answer is a second or two.
2. **CPU.** transformers.js runs a 135M model in a module worker: about 4–6 s to load from
   the cache, 20–60 s per answer depending on the machine. Slower, but a written answer
   rather than none.
3. **Search fallback.** If neither engine can start, the longest of the top-scoring
   passages is quoted verbatim from the site with its page named. Nothing can be invented.

The chosen engine is remembered per browser (`local-assistant.mode`), so a return visit
loads quietly instead of showing the download card again. The models are cached by the
browser itself; a page change never re-downloads them.

## What it will and will not do

- It answers only from the pages in the index. If the best passage scores below
  `relevanceThreshold`, the chat model is never called.
- Every generated answer is checked before it is shown: answers that echo the passage
  delimiters, answers built from words that do not appear in the retrieved passages, and
  answers that degenerate into loops are replaced with a refusal. A looping answer gets one
  colder retry first.
- It does not browse, call external APIs, keep history between visits, or answer questions
  about anything outside the index. Rebuild the index when the site's content changes.

## Measured behaviour (2026-10-29, RTX A4500 Laptop, Chromium 156, WebGPU)

Recorded with `bench/` on a 220-page, 5,645-chunk corpus and 20 fixed questions:

| Measure | Value |
|---|---:|
| Cold download (MiniLM 23 MB + SmolLM2 202 MB) | 225.01 MiB |
| Index size (json + bin) | 15.01 MiB |
| Engine init, warm cache | 2.8 s |
| Time to first token | 0.41–0.69 s typical, 3.4 s on the first question |
| Whole answer | 0.9–7.3 s |
| Unanswerable questions refused | 6 of 6 (after the answer guards) |

The smaller `SmolLM2-135M-Instruct-q0f16-MLC` was measured on the same 20 questions and
should not be chosen as the default: it downloaded 264.5 MiB of model files (562 s on the
same network, versus a warm 2.8 s init for 360M), refused **three** answerable questions
that 360M answered, and tended to answer by repeating the question line. Its answers were
faster once loaded (0.24–0.49 s to first token) but the quality drop is not worth the
smaller download.

These numbers come from one laptop GPU; phones and older machines will be slower, and the
first load is dominated by the download. Re-run `bench/bench.html` on any machine where you
want to know its numbers.

Measured again on 2026-10-30 with the models mirrored on the same host (`modelMirror`),
fresh browser profile each time:

| Measure | Chrome (CPU engine) | Firefox (CPU engine) | Chrome (GPU engine) |
|---|---:|---:|---:|
| First install, click to ready | 5.0–6.2 s | 4.75 s | 3.4 s |
| Later pages, click to ready | 4.4–6.6 s | 3.6–4.3 s | 3.4–3.8 s |
| Model requests after the first load | 0 | 0 | 0 |
| Answer | 25–57 s | 24.8 s | 5.9 s |

The same first install took five to six minutes from the public Hugging Face CDN, because
that connection ran at about 430 KB/s; mirroring the files is what turns it into seconds.

## Layout

```
loader.js            one-line entry point; registers the service worker
widget.js/.css       the chat window
dashboard.html/.js   browser indexing page (owner-only)
tabs.js              tab strip shared by the browser pages; the page
                     works without it (all panels stay readable)
embedder.js          MiniLM via transformers.js on WASM/CPU
ingest.js, sitemap.js, extract.js, chunk.js, indexcodec.js
retriever.js         cosine + keyword re-rank, relevance gate
prompt.js            grounded prompt, injection fencing, answer guards
chat.js              engine choice and lifecycle (WebLLM, then CPU)
cpuchat.js           transformers.js engine; cpu-worker.js runs the model off-thread
service-worker.js    offline cache for the widget and indexed pages
bench/               internal measurement harness (not loaded by the site)
wordpress/           plugin for the self-contained WordPress build
```

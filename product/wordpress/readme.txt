=== Grey Local Site AI Assistant ===
Contributors: 00greyok00
Tags: assistant, chatbot, search, offline, privacy
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 0.3.14
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A browser-run assistant that answers questions from this site's own pages. No server model, no API key.

== Description ==

Local Assistant adds a small chat panel to the site. The visitor asks a
question, the plugin finds the most relevant passages in the site's own pages,
and a small language model that runs in the visitor's browser writes the answer.
The answer cites the page it came from. If the pages do not answer the question,
the assistant says so instead of inventing one.

The site owner builds the search index once from the dashboard: the plugin walks
the sitemap, extracts the readable text of each page, and saves a searchable
index plus its vectors into `wp-content/uploads/local-assistant/`. Nothing is
sent to a server at any point.

* **Answers come from your pages.** Retrieval runs against the index built from
  this site; the model is instructed to refuse when the passages do not contain
  the answer.
* **The model runs on the visitor's device.** No server-side model, no API key,
  no per-answer cost, and question text never leaves the browser.
* **Works offline after the first visit.** A service worker caches the widget
  and the index, so a returning visitor can ask again without a network.
* **Two engine paths.** WebGPU is used when the browser offers it; a small CPU
  model is the fallback, and a plain search result is the last resort. The
  switch is silent, the visitor sees an answer, not engine jargon.

= External services =

The plugin itself calls no external service, and the site server never sends
visitor data anywhere. On the visitor's device, the browser downloads model
files the first time the assistant is used, after the visitor accepts the
consent card:

* **WebLLM** (Apache-2.0) fetches the conversation model, by default
  `SmolLM2-360M-Instruct-q4f16_1-MLC`, from the MLC model hub on Hugging Face.
* **Transformers.js** (Apache-2.0) fetches the embedding model
  `Xenova/all-MiniLM-L6-v2` and the CPU model `HuggingFaceTB/SmolLM2-135M-Instruct`
  from Hugging Face.
* **ONNX Runtime Web** (MIT) is bundled in the plugin; its WASM runtime is
  loaded from the plugin folder, not a CDN.
* **WebLLM's model library** is a WebAssembly module the engine compiles on the
  visitor's GPU. It ships inside the plugin
  (`dist/vendor/web-llm/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm`) and is
  loaded from the plugin folder, so no executable code is fetched from a third
  party at runtime.

Those downloads are the only network traffic the assistant causes, they are
started only after consent, and they go directly from the visitor's browser to
Hugging Face under Hugging Face's own terms. The site owner can point the
downloads at another host with the `modelBaseUrl`, `modelLibUrl`, and
`modelMirror` settings.

== Installation ==

1. Upload the plugin folder to `/wp-content/plugins/`, or install the zip from
   Plugins > Add New > Upload Plugin. The zip already contains the built
   `dist/` assets; no build step is needed.
2. Activate the plugin through the Plugins screen.
3. Open Settings > Local Assistant and press "Ingest site". The index is built
   in your browser and saved under `wp-content/uploads/local-assistant/`.
4. The assistant appears in the bottom-right corner of every public page.

== Frequently Asked Questions ==

= Does this send my visitors' questions to a server? =

No. Retrieval and generation both run in the visitor's browser. The question is
not transmitted anywhere, and there is no analytics or telemetry call.

= Why does the first answer take longer? =

The first use downloads the model files (roughly 100-400 MB depending on the
engine the browser supports) and caches them. Later visits start from the cache.

= Do I need a GPU? =

No. WebGPU makes answers faster where it is available; otherwise the plugin
loads a small CPU model, and if that cannot run it shows the closest matching
page instead.

= What happens if a page changes? =

Press "Ingest site" again. The index is rebuilt from the sitemap; there is no
schedule and no background job.

= Is the index public? =

It is written to `wp-content/uploads/local-assistant/`, which is normally
readable by visitors, that is what makes offline answers possible. It contains
text already published on the site, not private content.

== Changelog ==

= 0.3.14 =
* The CPU compatibility engine has its own `cpuModelMirror` key, so it
  downloads from Hugging Face by default instead of pointing at the site's
  search-model mirror and dying to same-origin 404s.
* While the CPU engine runs, the panel header says "CPU mode" instead of
  "Online", so the slower engine is never disguised.

= 0.3.13 =
* Failed verification no longer replaces a perfectly good answer with an
  absence claim; answer text, validation notices, and source links are
  separate elements published once.
* Empty model output, retrieval shortfall, heuristic rejection, and a
  successful answer now end in visibly different branches.
* "Related pages" render deduplicated below the answer; a diagnostics log
  (`config.devMode`) prints the pipeline to the console only.
* A visible build version sits in the panel header; the service-worker cache
  bumps so old runtime files cannot mix with the new deployment.

= 0.3.12 =
* Renamed Grey Local Site AI Assistant, so the directory slug names this plugin.
* Plugin Check reports no warnings: the settings flag uses filter_input(), and
  the upload reader's remaining notices carry documented annotations.

= 0.3.11 =
* The WebGPU model library is bundled and loaded from the plugin folder; the
  GPU engine no longer downloads executable WebAssembly from GitHub.
* The archive is under the directory's 10 MB limit: Node-only builds of the
  search runtime and the listing banners are no longer included.

= 0.3.10 =
* Licensed GPL-2.0-or-later and added the readme required for distribution.
* File moves and checks use WP_Filesystem and core helpers.
* The admin mark prints as a fixed literal so its SVG stays intact.
* The plugin archive now ships readable sources for its minified scripts.

= 0.3.9 =
* One source link per answer, without note numbers.

= 0.3.8 =
* The answer bubble shows only the verified answer, never the model's draft.
* Label-only passages are refused instead of quoted.

== Upgrade Notice ==

= 0.3.14 =
Fixes the CPU compatibility engine, which could not load on any deployment.

= 0.3.13 =
Answers stay on screen after generation completes.

= 0.3.12 =
Plugin Check clean: no warnings. No behaviour change.

= 0.3.11 =
The GPU model library now ships with the plugin instead of being downloaded.

= 0.3.10 =
Directory-compliance release: readme, GPL-2.0-or-later, filesystem helpers.
No behaviour change.

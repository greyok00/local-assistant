<?php
/**
 * Plugin Name: Grey Local Site AI Assistant
 * Description: A browser-only assistant that answers from this site's own pages.
 * Version: 0.3.15
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: grey-local-site-ai-assistant
 *
 * The plugin is a thin wrapper: it serves the built `dist/` assets, exposes the
 * public assistant config over REST, and stores the index artifact built in the
 * browser. No model runs on the server and nothing is sent to a third party.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('LOCAL_ASSISTANT_VERSION', '0.3.15');
define('LOCAL_ASSISTANT_DIR', plugin_dir_path(__FILE__));
define('LOCAL_ASSISTANT_URL', plugin_dir_url(__FILE__));
define('LOCAL_ASSISTANT_UPLOADS', 'local-assistant');


define('LOCAL_ASSISTANT_MAX_META_BYTES', 16 * 1024 * 1024);
define('LOCAL_ASSISTANT_MAX_BIN_BYTES', 64 * 1024 * 1024);










function local_assistant_mark(): void {
    $path = 'M22.00 10.25L20.33 9.28L19.37 8.32L19.37 7.18L18.67 7.70L18.40 6.82L17.61 7.53L17.00 8.58L15.95 9.02L15.25 9.02L15.33 9.37L14.19 9.37L14.28 9.63L12.96 9.54L13.14 9.89L9.98 9.81L6.04 10.60L4.37 10.60L3.05 10.16L2.00 9.19L2.09 9.98L2.53 10.95L3.32 11.65L3.05 11.82L4.02 12.09L3.93 12.35L5.42 12.35L7.09 11.74L6.65 12.70L5.68 13.75L7.53 13.14L6.47 14.11L4.28 14.02L3.93 14.19L2.96 15.51L2.09 15.86L2.00 16.21L3.14 16.30L4.54 14.98L4.81 15.25L4.19 16.12L3.32 16.65L3.32 17.00L4.54 17.00L5.68 15.60L7.00 15.60L8.40 14.89L9.89 13.23L9.54 12.88L9.81 12.79L12.00 13.23L12.18 13.40L11.91 13.58L12.96 13.58L12.79 13.84L14.81 13.84L15.68 13.40L16.91 14.98L17.96 15.51L20.33 17.18L21.56 17.18L21.30 16.65L20.33 16.39L18.14 14.19L16.82 13.67L17.00 13.49L18.93 13.32L19.46 13.75L19.46 14.37L19.72 14.81L19.89 14.54L20.16 14.98L20.33 14.89L20.42 14.02L19.63 12.53L19.37 12.35L17.96 12.53L17.88 12.35L19.54 10.68L20.16 10.60L20.86 11.04L21.56 11.04L21.74 10.77L21.21 10.60L21.12 10.33L21.82 10.51ZM20.60 10.86L20.86 10.77L20.42 10.51L20.16 10.60ZM17.79 9.28L17.88 9.46L18.32 9.19L18.23 9.02Z';
    echo '<span class="la-admin-logo" aria-hidden="true"><svg viewBox="0 0 24 24">'
        . '<path d="' . esc_attr($path) . '"/></svg></span>';
}


function local_assistant_move(string $from, string $to): bool {
    require_once ABSPATH . 'wp-admin/includes/file.php';
    global $wp_filesystem;
    if (!WP_Filesystem()) {
        return false;
    }
    return (bool) $wp_filesystem->move($from, $to, true);
}


function local_assistant_public_keys(): array {
    return [
        'siteName',
        'assistantName',
        'greeting',
        'indexPath',
        'model',
        'embedder',
        'relevanceThreshold',
        'topK',
        'maxAnswerWords',
        'accent',
        'maxPages',
        'modelBaseUrl',
        'modelLibUrl',
        'modelMirror',
        'cpuModel',
        'cpuDtype',
    ];
}

add_action('admin_menu', function () {
    add_options_page(
        'Local Assistant',
        'Local Assistant',
        'manage_options',
        'local-assistant',
        'local_assistant_render_admin'
    );
});


add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $links['local-assistant-settings'] = '<a href="'
        . esc_url(admin_url('options-general.php?page=local-assistant')) . '">Settings &amp; builder</a>';
    return $links;
});

function local_assistant_artifact_dir(): string {
    $uploads = wp_upload_dir();
    $dir = trailingslashit($uploads['basedir']) . LOCAL_ASSISTANT_UPLOADS;
    if (!is_dir($dir)) {
        wp_mkdir_p($dir);
    }
    return $dir;
}

function local_assistant_config(): array {
    $defaults = [
        'siteName' => get_bloginfo('name'),
        'assistantName' => 'AI Assistant',
        'greeting' => 'Ask about the pages on this site',
        'indexPath' => trailingslashit(wp_upload_dir()['baseurl']) . LOCAL_ASSISTANT_UPLOADS . '/assistant-index',
        'model' => 'SmolLM2-360M-Instruct-q4f16_1-MLC',
        'embedder' => 'Xenova/all-MiniLM-L6-v2',
        'relevanceThreshold' => 0.35,
        'topK' => 6,
        'maxAnswerWords' => 120,
        'accent' => '#e8622c',
        'maxPages' => 500,
        'modelBaseUrl' => '',
        
        
        'modelLibUrl' => local_assistant_model_lib_default(),
        
        
        'modelMirror' => local_assistant_model_mirror_default(),
        'cpuModel' => 'HuggingFaceTB/SmolLM2-135M-Instruct',
        'cpuDtype' => 'int8',
    ];
    return array_merge($defaults, (array) get_option('local_assistant_config', []));
}


function local_assistant_model_lib_default(): string {
    $file = 'dist/vendor/web-llm/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm';
    if (!is_file(LOCAL_ASSISTANT_DIR . $file)) {
        return '';
    }
    return LOCAL_ASSISTANT_URL . $file;
}


function local_assistant_model_mirror_default(): string {
    $uploads = wp_upload_dir();
    $dir = trailingslashit($uploads['basedir']) . LOCAL_ASSISTANT_UPLOADS . '/models/hf';
    if (!is_dir($dir)) {
        return '';
    }
    return trailingslashit($uploads['baseurl']) . LOCAL_ASSISTANT_UPLOADS . '/models/hf/';
}







function local_assistant_public_config_file(): string {
    return local_assistant_artifact_dir() . '/assistant-config.json';
}

function local_assistant_public_config_url(): string {
    $uploads = wp_upload_dir();
    return trailingslashit($uploads['baseurl']) . LOCAL_ASSISTANT_UPLOADS . '/assistant-config.json';
}

function local_assistant_write_public_config(): void {
    $json = wp_json_encode(local_assistant_public_config(), JSON_UNESCAPED_SLASHES);
    if (!is_string($json)) {
        return;
    }
    $file = local_assistant_public_config_file();
    if (is_file($file) && file_get_contents($file) === $json) {
        return;
    }
    $tmp = $file . '.' . wp_generate_password(8, false, false) . '.tmp';
    if (false === file_put_contents($tmp, $json)) {
        return;
    }
    if (!local_assistant_move($tmp, $file)) {
        wp_delete_file($tmp);
    }
}

add_action('update_option_local_assistant_config', 'local_assistant_write_public_config');
register_activation_hook(__FILE__, 'local_assistant_write_public_config');


function local_assistant_public_config(): array {
    $config = local_assistant_config();
    return array_intersect_key($config, array_flip(local_assistant_public_keys()));
}


function local_assistant_dist_ready(): bool {
    foreach (['loader.js', 'dashboard.js', 'widget.css'] as $file) {
        if (!file_exists(LOCAL_ASSISTANT_DIR . 'dist/' . $file)) {
            return false;
        }
    }
    return true;
}

function local_assistant_render_admin(): void {
    if (!current_user_can('manage_options')) {
        return;
    }
    $config = local_assistant_config();
    
    
    
    $start = null !== filter_input(INPUT_GET, 'settings-updated') ? 'settings' : 'build';
    ?>
    <div class="wrap" id="local-assistant-admin" data-tabs data-tab-start="<?php echo esc_attr($start); ?>">
      <header class="la-admin-head">
        <div class="la-admin-brand">
          <?php local_assistant_mark(); ?>
          <div>
            <h1><?php echo esc_html('Local Assistant'); ?></h1>
            <p class="la-admin-kicker"><?php echo esc_html('Website answers, built and answered in the browser.'); ?></p>
          </div>
        </div>
        <a class="la-admin-site" href="https://randybarham.com" target="_blank"
          rel="noopener">randybarham.com <span aria-hidden="true">&nearr;</span></a>
      </header>
      <?php if (!local_assistant_dist_ready()) : ?>
        <div class="notice notice-error"><p>
          <?php echo esc_html('The dist folder is missing. Run "npm run build" in the plugin source and copy product/dist/ next to this file before the assistant can load on the site.'); ?>
        </p></div>
      <?php endif; ?>

      <nav class="la-tabs-nav" role="tablist" aria-label="<?php echo esc_attr('Sections on this page'); ?>">
        <a id="la-tab-build" href="#build" role="tab" aria-controls="build"
          aria-selected="true" data-tab="build"><?php echo esc_html('Build'); ?></a>
        <a id="la-tab-install" href="#install" role="tab" aria-controls="install"
          aria-selected="false" data-tab="install"><?php echo esc_html('Install'); ?></a>
        <a id="la-tab-settings" href="#settings" role="tab" aria-controls="settings"
          aria-selected="false" data-tab="settings"><?php echo esc_html('Settings'); ?></a>
        <a id="la-tab-faq" href="#faq" role="tab" aria-controls="faq"
          aria-selected="false" data-tab="faq"><?php echo esc_html('FAQ'); ?></a>
      </nav>

      <section class="la-section" id="build" role="tabpanel" aria-labelledby="la-tab-build">
        <div class="la-panel">
          <p class="la-lead"><?php echo esc_html('Reads this site\'s sitemap and builds the index in this browser. Nothing is uploaded.'); ?></p>

          <label for="la-url" class="la-label"><?php echo esc_html('Site URL'); ?></label>
          <div class="la-row">
            <input id="la-url" type="url" class="regular-text" value="">
            <button class="button button-primary" id="la-start" type="button"><?php echo esc_html('Build index'); ?></button>
          </div>
          <div id="la-progress" class="la-bar"><span></span></div>
          <pre id="la-report">Ready when you are.</pre>
          <div id="la-download"></div>
          <p id="la-wp-save" hidden><button class="button" id="la-save" type="button" hidden><?php echo esc_html('Save to WordPress'); ?></button></p>
        </div>

        <div class="la-panel la-panel-quiet">
          <h2><?php echo esc_html('What you get'); ?></h2>
          <dl class="la-facts">
            <div><dt><?php echo esc_html('assistant-index.json'); ?></dt><dd><?php echo esc_html('Page titles, headings, chunk text, and source URLs.'); ?></dd></div>
            <div><dt><?php echo esc_html('assistant-index.bin'); ?></dt><dd><?php echo esc_html('One number vector per chunk, used to rank pages.'); ?></dd></div>
          </dl>
          <p class="la-note"><?php echo esc_html('Press Save to WordPress when the build finishes.'); ?></p>
        </div>
      </section>

      <section class="la-section" id="install" role="tabpanel" aria-labelledby="la-tab-install">
        <p class="la-lead"><?php echo esc_html('Static folder or this plugin; both use the two files from Build.'); ?></p>

        <div class="la-cols">
          <div class="la-panel">
            <h2><?php echo esc_html('Static site'); ?></h2>
            <ol class="la-steps">
              <li><?php echo esc_html('Copy the assistant folder to your site, for example /assistant/.'); ?></li>
              <li><?php echo esc_html('Upload the two index files from the Build tab into that same folder.'); ?></li>
              <li><?php echo esc_html('Add this line before the closing body tag on every page:'); ?>
                <pre class="la-code">&lt;script type="module" src="/assistant/loader.js"
  data-assistant data-config="/assistant/assistant.config.json"&gt;&lt;/script&gt;</pre>
              </li>
              <li><?php echo esc_html('Reload the site twice. The chat pill appears bottom-right.'); ?></li>
            </ol>
            <p class="la-note"><?php echo esc_html('The site must be served over HTTPS or localhost; browsers block the model on plain HTTP and from file://.'); ?></p>
          </div>

          <div class="la-panel">
            <h2><?php echo esc_html('WordPress'); ?></h2>
            <ol class="la-steps">
              <li><?php echo esc_html('Upload the plugin zip in Plugins > Add New > Upload Plugin.'); ?></li>
              <li><?php echo esc_html('Activate it, then open Settings > Local Assistant.'); ?></li>
              <li><?php echo esc_html('Enter the site URL, press Build index, then Save to WordPress.'); ?></li>
              <li><?php echo esc_html('The assistant appears on every public page; no theme edit needed.'); ?></li>
            </ol>
            <p class="la-note"><?php echo esc_html('The index is stored in wp-content/uploads/local-assistant/.'); ?></p>
          </div>
        </div>

      </section>

      <section class="la-section" id="settings" role="tabpanel" aria-labelledby="la-tab-settings">
        <p class="la-lead"><?php echo esc_html('These are the values the assistant reads at run time. They are stored with WordPress; there is no config file to copy.'); ?></p>
        <form method="post" action="options.php" class="la-panel la-settings">
          <?php settings_fields('local_assistant'); ?>
          <div class="la-field">
            <label for="la-assistant-name"><?php echo esc_html('Assistant name'); ?></label>
            <input id="la-assistant-name" type="text" name="local_assistant_config[assistantName]"
              value="<?php echo esc_attr($config['assistantName']); ?>">
          </div>
          <div class="la-field">
            <label for="la-greeting"><?php echo esc_html('Greeting'); ?></label>
            <input id="la-greeting" type="text" name="local_assistant_config[greeting]"
              value="<?php echo esc_attr($config['greeting']); ?>">
          </div>
          <div class="la-field">
            <label for="la-accent"><?php echo esc_html('Fallback accent'); ?></label>
            <input id="la-accent" type="text" name="local_assistant_config[accent]"
              value="<?php echo esc_attr($config['accent']); ?>" pattern="#[0-9a-fA-F]{6}" spellcheck="false">
            <p class="la-hint"><?php echo esc_html('Used only when the theme exposes no color of its own.'); ?></p>
          </div>
          <div class="la-pair">
            <div class="la-field">
              <label for="la-topk"><?php echo esc_html('Pages per answer'); ?></label>
              <input id="la-topk" type="number" min="1" max="20" step="1"
                name="local_assistant_config[topK]" value="<?php echo esc_attr((string) $config['topK']); ?>">
              <p class="la-hint"><?php echo esc_html('How many matching sections are read before answering.'); ?></p>
            </div>
            <div class="la-field">
              <label for="la-words"><?php echo esc_html('Answer length cap'); ?></label>
              <input id="la-words" type="number" min="20" max="400" step="10"
                name="local_assistant_config[maxAnswerWords]" value="<?php echo esc_attr((string) $config['maxAnswerWords']); ?>">
              <p class="la-hint"><?php echo esc_html('Words, before the assistant stops.'); ?></p>
            </div>
          </div>
          <div class="la-pair">
            <div class="la-field">
              <label for="la-threshold"><?php echo esc_html('Relevance floor'); ?></label>
              <input id="la-threshold" type="number" min="0.05" max="0.95" step="0.01"
                name="local_assistant_config[relevanceThreshold]" value="<?php echo esc_attr((string) $config['relevanceThreshold']); ?>">
              <p class="la-hint"><?php echo esc_html('Lower answers more loosely; higher refuses more often.'); ?></p>
            </div>
            <div class="la-field">
              <label for="la-pages"><?php echo esc_html('Pages per build'); ?></label>
              <input id="la-pages" type="number" min="1" step="1"
                name="local_assistant_config[maxPages]" value="<?php echo esc_attr((string) $config['maxPages']); ?>">
              <p class="la-hint"><?php echo esc_html('Large sites stop at this count.'); ?></p>
            </div>
          </div>
          <p class="la-actions"><?php submit_button('Save', 'primary', 'submit', false); ?></p>
        </form>
      </section>

      <section class="la-section" id="faq" role="tabpanel" aria-labelledby="la-tab-faq">
        <div class="la-faq">
          <details>
            <summary><?php echo esc_html('Does anything leave my server?'); ?></summary>
            <p><?php echo esc_html('No. The page downloads the site\'s own HTML, builds vectors in the browser, and stores the result in uploads. There is no account, no API key, and no third-party request.'); ?></p>
          </details>
          <details>
            <summary><?php echo esc_html('How often should I rebuild?'); ?></summary>
            <p><?php echo esc_html('Only when the content changes. The index is a snapshot: new or edited pages stay invisible to the assistant until you rebuild and save again.'); ?></p>
          </details>
          <details>
            <summary><?php echo esc_html('Where does the index go?'); ?></summary>
            <p><?php echo esc_html('The plugin stores it in wp-content/uploads/local-assistant/. No file copying is needed.'); ?></p>
          </details>
          <details>
            <summary><?php echo esc_html('Will visitors on phones see it?'); ?></summary>
            <p><?php echo esc_html('Yes. The assistant appears on every public page and works on phones, tablets, and every current browser.'); ?></p>
          </details>
          <details>
            <summary><?php echo esc_html('Does it match my theme?'); ?></summary>
            <p><?php echo esc_html('The widget samples the page background, text, and accent color, so no styling is required. The fallback accent setting is used only when the theme exposes no color.'); ?></p>
          </details>
          <details>
            <summary><?php echo esc_html('It says it could not read the site.'); ?></summary>
            <p><?php echo esc_html('Usually a cross-origin block. Ingest this site from its own admin page, which is what the field already points at.'); ?></p>
          </details>
          <details>
            <summary><?php echo esc_html('How large will the index be?'); ?></summary>
            <p><?php echo esc_html('Roughly 1.5 KB of vectors per chunk and a little more in metadata, so a few hundred pages usually lands between 2 and 6 MB in total.'); ?></p>
          </details>
        </div>
      </section>
    </div>
    <?php
}

add_action('admin_init', function () {
    register_setting('local_assistant', 'local_assistant_config', [
        'type' => 'array',
        
        
        'sanitize_callback' => function ($input) {
            $clean = [];
            if (!is_array($input)) {
                return $clean;
            }
            if (isset($input['accent']) && preg_match('/^#[0-9a-fA-F]{6}$/', (string) $input['accent'])) {
                $clean['accent'] = (string) $input['accent'];
            }
            foreach (['assistantName', 'greeting'] as $key) {
                if (!isset($input[$key])) {
                    continue;
                }
                $value = sanitize_text_field((string) $input[$key]);
                if ('' !== trim($value)) {
                    $clean[$key] = $value;
                }
            }
            foreach (['topK' => [1, 20], 'maxAnswerWords' => [20, 400], 'maxPages' => [1, 100000]] as $key => $range) {
                if (!isset($input[$key]) || !is_numeric($input[$key])) {
                    continue;
                }
                $number = (int) $input[$key];
                if ($number >= $range[0] && $number <= $range[1]) {
                    $clean[$key] = $number;
                }
            }
            if (isset($input['relevanceThreshold']) && is_numeric($input['relevanceThreshold'])) {
                $threshold = (float) $input['relevanceThreshold'];
                if ($threshold > 0 && $threshold < 1) {
                    $clean['relevanceThreshold'] = $threshold;
                }
            }
            return $clean;
        },
    ]);
});



add_action('rest_api_init', function () {
    register_rest_route('local-assistant/v1', '/config', [
        'methods' => 'GET',
        'callback' => function () {
            $response = rest_ensure_response(local_assistant_public_config());
            $response->header('Cache-Control', 'public, max-age=300');
            return $response;
        },
        'permission_callback' => '__return_true',
    ]);
});







function local_assistant_read_upload(string $key, int $max_bytes): ?string {
    // phpcs:ignore WordPress.Security.NonceVerification.Missing -- the AJAX handler verifies its nonce with check_ajax_referer() before calling this helper.
    if (!isset($_FILES[$key]) || !is_array($_FILES[$key])) {
        return null;
    }
    // phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- the bytes are validated as JSON metadata and LAI1 binary before use.
    $file = $_FILES[$key];
    if (!isset($file['error']) || UPLOAD_ERR_OK !== $file['error']) {
        return null;
    }
    if (empty($file['tmp_name']) || !is_uploaded_file($file['tmp_name'])) {
        return null;
    }
    $declared = isset($file['size']) ? (int) $file['size'] : 0;
    if ($declared <= 0 || $declared > $max_bytes) {
        return null;
    }
    $actual = filesize($file['tmp_name']);
    if (false === $actual || $actual <= 0 || $actual > $max_bytes) {
        return null;
    }
    $bytes = file_get_contents($file['tmp_name']);
    if (false === $bytes || '' === $bytes) {
        return null;
    }
    return $bytes;
}








function local_assistant_validate_bin(string $bin, int $chunk_count): ?string {
    if (strlen($bin) < 12 || 0 !== strncmp($bin, 'LAI1', 4)) {
        return 'invalid artifact header';
    }
    $header = unpack('vversion/vdims/Vcount', substr($bin, 4, 8));
    if (!is_array($header)) {
        return 'invalid artifact header';
    }
    if (1 !== $header['version']) {
        return 'unsupported index version';
    }
    if (384 !== $header['dims']) {
        return 'wrong vector dimensions';
    }
    if ($header['count'] !== $chunk_count) {
        return 'vector count does not match metadata';
    }
    if (strlen($bin) !== 12 + $header['count'] * 384 * 4) {
        return 'truncated or oversized vectors';
    }
    return null;
}


function local_assistant_write_artifact(string $meta, string $bin): bool {
    $dir = local_assistant_artifact_dir();
    if (!is_dir($dir) || !wp_is_writable($dir)) {
        return false;
    }
    $meta_tmp = $dir . '/assistant-index.json.' . wp_generate_password(8, false, false) . '.tmp';
    $bin_tmp = $dir . '/assistant-index.bin.' . wp_generate_password(8, false, false) . '.tmp';
    if (false === file_put_contents($meta_tmp, $meta, LOCK_EX)) {
        return false;
    }
    if (false === file_put_contents($bin_tmp, $bin, LOCK_EX)) {
        wp_delete_file($meta_tmp);
        return false;
    }
    
    
    if (!local_assistant_move($bin_tmp, $dir . '/assistant-index.bin')) {
        wp_delete_file($meta_tmp);
        wp_delete_file($bin_tmp);
        return false;
    }
    if (!local_assistant_move($meta_tmp, $dir . '/assistant-index.json')) {
        wp_delete_file($meta_tmp);
        return false;
    }
    return true;
}

add_action('wp_ajax_local_assistant_save', function () {
    check_ajax_referer('local_assistant_save', 'nonce');
    if (!current_user_can('manage_options')) {
        wp_send_json_error(['message' => 'forbidden'], 403);
    }

    $meta = local_assistant_read_upload('meta', LOCAL_ASSISTANT_MAX_META_BYTES);
    $bin = local_assistant_read_upload('bin', LOCAL_ASSISTANT_MAX_BIN_BYTES);
    if (null === $meta || null === $bin) {
        wp_send_json_error(['message' => 'missing, failed, or oversized artifact'], 400);
    }
    $json = json_decode($meta, true);
    if (!is_array($json) || !isset($json['chunks']) || !is_array($json['chunks'])) {
        wp_send_json_error(['message' => 'invalid metadata'], 400);
    }

    $bin_error = local_assistant_validate_bin($bin, count($json['chunks']));
    if (null !== $bin_error) {
        wp_send_json_error(['message' => $bin_error], 400);
    }

    if (!local_assistant_write_artifact($meta, $bin)) {
        wp_send_json_error(['message' => 'could not write the artifact to uploads; re-run Ingest'], 500);
    }

    $uploads = wp_upload_dir();
    wp_send_json_success([
        'path' => trailingslashit($uploads['baseurl']) . LOCAL_ASSISTANT_UPLOADS . '/',
    ]);
});



add_action('wp_enqueue_scripts', function () {
    if (is_admin() || is_feed()) {
        return;
    }
    if (!local_assistant_dist_ready()) {
        return;
    }
    
    
    if (!is_file(local_assistant_public_config_file())) {
        local_assistant_write_public_config();
    }
    wp_enqueue_script(
        'local-assistant-loader',
        LOCAL_ASSISTANT_URL . 'dist/loader.js',
        [],
        LOCAL_ASSISTANT_VERSION,
        ['in_footer' => true, 'strategy' => 'defer']
    );
    wp_enqueue_style(
        'local-assistant-widget',
        LOCAL_ASSISTANT_URL . 'dist/widget.css',
        [],
        LOCAL_ASSISTANT_VERSION
    );
});



add_filter('script_loader_tag', function ($tag, $handle, $src) {
    if ('local-assistant-loader' === $handle) {
        
        $config_url = is_file(local_assistant_public_config_file())
            ? local_assistant_public_config_url()
            : rest_url('local-assistant/v1/config');
        return str_replace(
            '<script ',
            sprintf(
                '<script type="module" data-assistant data-config="%s" ',
                esc_attr($config_url)
            ),
            $tag
        );
    }
    if ('local-assistant-dashboard' === $handle) {
        return str_replace('<script ', '<script type="module" ', $tag);
    }
    return $tag;
}, 10, 3);

add_action('admin_enqueue_scripts', function ($hook) {
    if ('settings_page_local-assistant' !== $hook) {
        return;
    }
    
    
    wp_register_style('local-assistant-admin', false, [], LOCAL_ASSISTANT_VERSION);
    wp_enqueue_style('local-assistant-admin');
    
    
    wp_add_inline_style(
        'local-assistant-admin',
        '#local-assistant-admin{'
        . '--la-bg:#14171b;--la-panel:#1b1f24;--la-panel-2:#20252b;--la-line:#2b323a;'
        . '--la-line-soft:#242a31;--la-ink:#e8ebef;--la-muted:#9aa4b0;'
        . '--la-accent:#e2a33f;--la-accent-ink:#1a1205;'
        . 'max-width:900px;margin:16px 16px 0 0;padding:16px 18px 20px;color:var(--la-ink);font-size:13px;line-height:1.5;'
        . 'background:radial-gradient(900px 260px at 100% 0,rgba(226,163,63,.07),transparent 62%),var(--la-bg);'
        . 'border:1px solid var(--la-line);border-radius:12px;'
        . 'box-shadow:0 22px 60px rgba(0,0,0,.18);}'
        . '#local-assistant-admin *{box-sizing:border-box;}'
        
        
        . '#local-assistant-admin [hidden]{display:none !important;}'
        . '#local-assistant-admin a{color:var(--la-accent);}'
        . '#local-assistant-admin h1{margin:0;padding:0;color:var(--la-ink);font-size:19px;line-height:1.25;}'
        . '#local-assistant-admin h2{margin:0 0 8px;padding:0;color:var(--la-ink);font-size:14px;}'
        . '#local-assistant-admin .la-admin-head{display:flex;align-items:center;gap:12px;'
        . 'padding-bottom:12px;border-bottom:1px solid var(--la-line-soft);}'
        . '#local-assistant-admin .la-admin-brand{display:flex;align-items:center;gap:11px;'
        . 'flex:1 1 auto;min-width:0;}'
        . '#local-assistant-admin .la-admin-logo{width:32px;height:32px;flex:none;display:grid;'
        . 'place-items:center;border-radius:9px;color:var(--la-accent);'
        . 'background:linear-gradient(180deg,#272d34,#1d2228);border:1px solid #3a434d;'
        . 'box-shadow:inset 0 1px 0 rgba(255,255,255,.05);}'
        . '#local-assistant-admin .la-admin-logo svg{width:19px;height:19px;fill:currentColor;}'
        . '#local-assistant-admin .la-admin-kicker{margin:2px 0 0;color:var(--la-muted);font-size:12px;}'
        . '#local-assistant-admin .la-admin-site{margin-left:auto;padding:4px 10px;'
        . 'border:1px solid var(--la-line);border-radius:999px;background:var(--la-panel);'
        . 'color:var(--la-muted);font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;}'
        . '#local-assistant-admin .la-admin-site:hover,'
        . '#local-assistant-admin .la-admin-site:focus{border-color:#3d4652;color:var(--la-ink);}'
        
        . '#local-assistant-admin .la-tabs-nav{display:flex;flex-wrap:wrap;gap:2px;'
        . 'width:fit-content;max-width:100%;margin:12px 0 14px;padding:3px;'
        . 'background:var(--la-panel);border:1px solid var(--la-line);border-radius:8px;}'
        . '#local-assistant-admin .la-tabs-nav a{padding:5px 10px;border-radius:6px;'
        . 'color:var(--la-muted);font-size:12.5px;font-weight:600;text-decoration:none;}'
        . '#local-assistant-admin .la-tabs-nav a:hover,#local-assistant-admin .la-tabs-nav a:focus{'
        . 'background:var(--la-panel-2);color:var(--la-ink);text-decoration:none;}'
        . '#local-assistant-admin .la-tabs-nav a.is-on{background:#262c33;color:var(--la-ink);'
        . 'box-shadow:inset 0 0 0 1px var(--la-line);}'
        . '#local-assistant-admin .la-section{margin:0;padding:0;}'
        . '#local-assistant-admin .la-lead{margin:0 0 12px;color:var(--la-muted);max-width:70ch;}'
        . '#local-assistant-admin .la-panel{max-width:760px;background:var(--la-panel);'
        . 'border:1px solid var(--la-line);border-radius:10px;padding:12px 14px;margin:0 0 12px;}'
        . '#local-assistant-admin .la-panel-quiet{background:var(--la-panel-2);}'
        . '#local-assistant-admin .la-panel p{color:var(--la-muted);margin:0 0 8px;}'
        . '#local-assistant-admin .la-panel p:last-child{margin-bottom:0;}'
        . '#local-assistant-admin .la-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;}'
        . '#local-assistant-admin .la-label{display:block;font-weight:600;font-size:12px;margin:0 0 5px;color:var(--la-ink);}'
        . '#local-assistant-admin .la-row{display:flex;gap:8px;margin-bottom:4px;}'
        . '#local-assistant-admin .la-row input{flex:1 1 auto;min-width:0;}'
        . '#local-assistant-admin .la-bar{height:6px;background:#171b20;border:1px solid var(--la-line);'
        . 'border-radius:999px;overflow:hidden;margin:14px 0 0;}'
        . '#local-assistant-admin .la-bar span{display:block;height:100%;width:0;'
        . 'background:var(--la-accent);transition:width .2s;}'
        . '#local-assistant-admin #la-report{margin:12px 0 0;white-space:pre-wrap;background:#171b20;'
        . 'border:1px solid var(--la-line);color:var(--la-ink);padding:10px 12px;border-radius:8px;'
        . 'font-size:12.5px;min-height:54px;}'
        . '#local-assistant-admin .la-file{display:inline-block;margin:8px 12px 0 0;color:var(--la-accent);}'
        . '#local-assistant-admin .la-note{color:var(--la-muted);font-size:12.5px;margin:10px 0 0;}'
        . '#local-assistant-admin .la-facts{margin:0;display:grid;gap:8px;}'
        . '#local-assistant-admin .la-facts div{display:grid;grid-template-columns:170px 1fr;gap:10px;}'
        . '#local-assistant-admin .la-facts dt{font-weight:600;font-size:12.5px;color:var(--la-ink);}'
        . '#local-assistant-admin .la-facts dd{margin:0;color:var(--la-muted);font-size:12.5px;}'
        . '#local-assistant-admin .la-steps{margin:0;padding-left:18px;display:grid;gap:8px;font-size:13px;min-width:0;color:var(--la-muted);}'
        
        
        . '#local-assistant-admin .la-steps li{min-width:0;}'
        . '#local-assistant-admin .la-code{margin:8px 0 0;padding:10px 12px;max-width:100%;white-space:pre;'
        . 'overflow-x:auto;background:#171b20;border:1px solid var(--la-line);border-radius:7px;'
        . 'font-size:12px;line-height:1.5;color:var(--la-ink);}'
        
        . '#local-assistant-admin .la-settings{display:grid;gap:12px;}'
        . '#local-assistant-admin .la-field{display:flex;flex-direction:column;gap:4px;min-width:0;}'
        . '#local-assistant-admin .la-field label{font-size:12px;font-weight:600;color:var(--la-ink);}'
        . '#local-assistant-admin .la-field input{width:100%;}'
        . '#local-assistant-admin .la-hint{margin:0;color:var(--la-muted);font-size:11.5px;}'
        . '#local-assistant-admin .la-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;}'
        . '#local-assistant-admin .la-actions{margin:0;}'
        . '#local-assistant-admin .la-faq{display:grid;gap:6px;max-width:760px;}'
        . '#local-assistant-admin .la-faq details{background:var(--la-panel-2);'
        . 'border:1px solid var(--la-line);border-radius:8px;padding:0 13px;}'
        . '#local-assistant-admin .la-faq details[open]{background:var(--la-panel);}'
        . '#local-assistant-admin .la-faq summary{cursor:pointer;list-style:none;'
        . 'font-weight:600;font-size:12.5px;padding:10px 0;color:var(--la-ink);}'
        . '#local-assistant-admin .la-faq summary::-webkit-details-marker{display:none;}'
        . '#local-assistant-admin .la-faq p{margin:0 0 10px;color:var(--la-muted);max-width:70ch;font-size:12.5px;}'
        . '#local-assistant-admin input[type="text"],#local-assistant-admin input[type="url"],'
        . '#local-assistant-admin input[type="number"]{'
        . 'background:#171b20;border:1px solid #333b44;border-radius:7px;color:var(--la-ink);'
        . 'box-shadow:none;padding:4px 8px;}'
        . '#local-assistant-admin input[type="text"]:focus,#local-assistant-admin input[type="url"]:focus,'
        . '#local-assistant-admin input[type="number"]:focus{'
        . 'border-color:var(--la-accent);box-shadow:0 0 0 1px var(--la-accent);outline:none;}'
        . '#local-assistant-admin .form-table th,#local-assistant-admin .form-table td{color:var(--la-ink);}'
        . '#local-assistant-admin .description,#local-assistant-admin .description p{color:var(--la-muted);}'
        . '#local-assistant-admin .button,#local-assistant-admin .button-secondary{'
        . 'background:var(--la-panel-2);border:1px solid var(--la-line);border-radius:7px;'
        . 'color:var(--la-ink);text-shadow:none;box-shadow:none;}'
        . '#local-assistant-admin .button:hover,#local-assistant-admin .button-secondary:hover{'
        . 'background:#262c33;border-color:#3d4652;color:#fff;}'
        . '#local-assistant-admin .button-primary{background:var(--la-accent);'
        . 'border-color:#c9902f;color:var(--la-accent-ink);font-weight:600;}'
        . '#local-assistant-admin .button-primary:hover,#local-assistant-admin .button-primary:focus{'
        . 'background:#f0b455;border-color:#d89b34;color:var(--la-accent-ink);}'
        . '#local-assistant-admin .notice{background:var(--la-panel-2);border:1px solid var(--la-line);'
        . 'border-left-width:4px;border-radius:8px;color:var(--la-ink);box-shadow:none;}'
        . '#local-assistant-admin .notice p{color:var(--la-ink);}'
        . '#local-assistant-admin .notice-error{border-left-color:#f07a6e;}'
        . '@media (max-width:782px){#local-assistant-admin{margin-right:10px;padding:14px 12px 18px;}'
        . '#local-assistant-admin .la-admin-head{flex-wrap:wrap;}'
        . '#local-assistant-admin .la-admin-site{margin-left:0;}'
        . '#local-assistant-admin .la-cols,#local-assistant-admin .la-pair{grid-template-columns:1fr;}'
        . '#local-assistant-admin .la-row{flex-wrap:wrap;}}'
    );

    
    
    if (file_exists(LOCAL_ASSISTANT_DIR . 'dist/tabs.js')) {
        wp_enqueue_script(
            'local-assistant-tabs',
            LOCAL_ASSISTANT_URL . 'dist/tabs.js',
            [],
            LOCAL_ASSISTANT_VERSION,
            ['in_footer' => true, 'strategy' => 'defer']
        );
    }

    if (!local_assistant_dist_ready()) {
        return;
    }
    $config = local_assistant_config();
    wp_enqueue_script(
        'local-assistant-dashboard',
        LOCAL_ASSISTANT_URL . 'dist/dashboard.js',
        [],
        LOCAL_ASSISTANT_VERSION,
        ['in_footer' => true, 'strategy' => 'defer']
    );
    wp_add_inline_script(
        'local-assistant-dashboard',
        'window.wpAssistant = ' . wp_json_encode([
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce('local_assistant_save'),
            'siteName' => get_bloginfo('name'),
            'embedder' => $config['embedder'],
            'maxPages' => $config['maxPages'],
        ], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . ';',
        'before'
    );
});

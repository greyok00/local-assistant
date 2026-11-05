#!/usr/bin/env bash
# Lint + structural checks for the WordPress plugin wrapper.
# There is no WordPress here, so this is php -l plus targeted greps.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plugin="$here/../../wordpress/local-assistant.php"
readme="$here/../../wordpress/readme.txt"

php -l "$plugin"

# Core contract kept from the brief.
grep -q "local_assistant_save" "$plugin"
grep -q "check_ajax_referer" "$plugin"
grep -q "current_user_can" "$plugin"
grep -q "UPLOAD_ERR_OK" "$plugin"

# Vector header is parsed, not just magic-sniffed.
grep -q "local_assistant_validate_bin" "$plugin"
grep -q "unpack('vversion/vdims/Vcount'" "$plugin"
grep -q "vector count does not match metadata" "$plugin"
grep -q "truncated or oversized vectors" "$plugin"

# Contradiction fix 1: module loader + data attributes + public REST config.
grep -q "dist/loader.js" "$plugin"
grep -q "script_loader_tag" "$plugin"
grep -q "type=\"module\"" "$plugin"
grep -q "data-assistant" "$plugin"
grep -q "data-config" "$plugin"
grep -q "register_rest_route" "$plugin"
grep -q "local-assistant/v1" "$plugin"
! grep -q "window.localAssistantConfig" "$plugin"

# Contradiction fix 2: dashboard markup IDs and script handle.
for id in la-url la-start la-progress la-report la-download la-save; do
  grep -q "id=\"$id\"" "$plugin"
done
grep -q "dist/dashboard.js" "$plugin"
grep -q "window.wpAssistant" "$plugin"
grep -q "dashboard.js" "$plugin"
grep -q "widget.css" "$plugin"

# Deployment limitations documented.
grep -q "Service-Worker-Allowed" "$readme"
grep -q "Cache-Control" "$readme"

echo "plugin checks passed"

/**
 * Assistant configuration: defaults, the shape each key accepts, and the
 * validation shared by the static build and the WordPress settings screen.
 */
const DEFAULTS = {
  siteName: 'This site',
  assistantName: 'AI Assistant',
  greeting: 'Ask about the pages on this site',
  indexPath: '/local-assistant/assistant-index',
  // q4f16_1 is the only quantisation WebLLM 0.2.86 publishes for SmolLM2; the
  // 135M model ships only q0f16/q0f32 there, so 360M-q4f16_1 is the default.
  model: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
  // The compatibility engine: a smaller model from the same family, run by
  // transformers.js on the CPU for browsers without WebGPU. Empty disables it
  // and leaves the search-only fallback in its place.
  cpuModel: 'HuggingFaceTB/SmolLM2-135M-Instruct',
  cpuDtype: 'int8',
  embedder: 'Xenova/all-MiniLM-L6-v2',
  relevanceThreshold: 0.35,
  topK: 6,
  maxAnswerWords: 120,
  accent: '#e8622c',
  maxPages: 500,
  // Empty means WebLLM's own origins (Hugging Face for weights, GitHub for
  // the model-specific wasm). Set both URLs to serve a strictly self-hosted
  // deployment with no third-party requests.
  modelBaseUrl: '',
  modelLibUrl: '',
  // Optional mirror for the Hugging Face models (search model + CPU model),
  // laid out as <mirror>/<org>/<model>/<file>. A site that hosts the files
  // itself loads them at LAN speed instead of the public CDN.
  modelMirror: '',
  // Optional mirror for the CPU chat weights only; empty = Hugging Face. Kept
  // separate from modelMirror because the site mirror hosts the small search
  // model, not the compatibility model.
  cpuModelMirror: ''
};

export const DEFAULT_CONFIG = Object.freeze({ ...DEFAULTS });

const HEX = /^#[0-9a-fA-F]{6}$/;

export function validateConfig(raw = {}) {
  const errors = [];
  const config = { ...DEFAULTS };

  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      errors.push(`unknown key: ${key}`);
      continue;
    }
    config[key] = value;
  }

  if (typeof config.indexPath !== 'string' || !config.indexPath.trim()) {
    errors.push('indexPath must be a non-empty string');
  } else if (/\.(json|bin)$/i.test(config.indexPath)) {
    errors.push('indexPath must be the stem without .json/.bin');
  }

  if (!Number.isFinite(config.relevanceThreshold) ||
      config.relevanceThreshold <= 0 || config.relevanceThreshold >= 1) {
    errors.push('relevanceThreshold must be between 0 and 1');
  }

  if (!Number.isInteger(config.topK) || config.topK < 1 || config.topK > 20) {
    errors.push('topK must be an integer between 1 and 20');
  }

  if (!Number.isInteger(config.maxAnswerWords) || config.maxAnswerWords < 20 || config.maxAnswerWords > 400) {
    errors.push('maxAnswerWords must be an integer between 20 and 400');
  }

  if (!Number.isInteger(config.maxPages) || config.maxPages < 1) {
    errors.push('maxPages must be a positive integer');
  }

  // Relative paths are resolved next to the config file by the loader, the
  // same rule as indexPath, so a mirror can move with the install folder.
  // Any path that is not absolute counts as relative ("mirror/model" included);
  // only a foreign scheme or a protocol-relative "//host" is rejected.
  const isRelativeOrHttps = (value) => {
    if (value === '') return true;
    if (/^https:\/\/[^/\s]+/i.test(value)) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
    return !value.startsWith('//') && !/\s/.test(value);
  };

  if (typeof config.modelBaseUrl !== 'string' || !isRelativeOrHttps(config.modelBaseUrl)) {
    errors.push('modelBaseUrl must be empty, a path relative to the config, or an https URL');
  }

  if (typeof config.modelLibUrl !== 'string' || !isRelativeOrHttps(config.modelLibUrl)) {
    errors.push('modelLibUrl must be empty, a path relative to the config, or an https URL');
  }

  if (typeof config.modelMirror !== 'string' || !isRelativeOrHttps(config.modelMirror)) {
    errors.push('modelMirror must be empty, a path relative to the config, or an https URL');
  }
  if (typeof config.cpuModelMirror !== 'string' || !isRelativeOrHttps(config.cpuModelMirror)) {
    errors.push('cpuModelMirror must be empty, a path relative to the config, or an https URL');
  }

  // Exactly two path segments, neither of them a dot segment: "../evil" would
  // otherwise satisfy the "owner/model" shape.
  const hubId = (value) => value.split('/');
  const isHubId = (value) => {
    const parts = hubId(value);
    return parts.length === 2 && parts.every(part =>
      /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !/^\.\.?$/.test(part));
  };
  if (typeof config.cpuModel !== 'string' || !(config.cpuModel === '' || isHubId(config.cpuModel))) {
    errors.push('cpuModel must be empty or "owner/model"');
  }

  const DTYPES = new Set(['int8', 'q8', 'uint8', 'q4', 'fp32', 'fp16']);
  if (!DTYPES.has(config.cpuDtype)) {
    errors.push(`cpuDtype must be one of ${[...DTYPES].join(', ')}`);
  }

  if (!HEX.test(config.accent)) {
    errors.push('accent must be a 6-digit hex color');
  }

  for (const key of ['siteName', 'assistantName', 'greeting', 'model', 'embedder']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      errors.push(`${key} must be a non-empty string`);
    }
  }

  // Both ids are Hugging Face / WebLLM identifiers: one token, no spaces or
  // slashes. A typo here used to pass validation silently and then downgrade
  // every visitor to the CPU model with no explanation.
  if (typeof config.model === 'string' && config.model.trim() && !/^[A-Za-z0-9._-]+$/.test(config.model)) {
    errors.push('model must be a single WebLLM model id (letters, digits, dot, dash, underscore)');
  }

  return { ok: errors.length === 0, errors, config: Object.freeze(config) };
}

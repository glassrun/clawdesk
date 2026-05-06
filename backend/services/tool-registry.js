/**
 * Tool Registry Service
 * Maintains a registry of available tools with metadata: description, risk level, rate limits.
 */

const tools = {
  read: {
    name: 'read',
    description: 'Read file contents. Supports offset/limit for large files.',
    riskLevel: 'low',       // read-only, no side effects
    rateLimit: { maxPerMinute: 120, burst: 20 },
    enabled: true,
    version: '1.0.0',
  },
  write: {
    name: 'write',
    description: 'Create or overwrite files. Automatically creates parent directories.',
    riskLevel: 'medium',    // writes files to disk
    rateLimit: { maxPerMinute: 60, burst: 10 },
    enabled: true,
    version: '1.0.0',
  },
  exec: {
    name: 'exec',
    description: 'Run shell commands. Supports background execution and PTY mode.',
    riskLevel: 'high',     // arbitrary command execution
    rateLimit: { maxPerMinute: 30, burst: 5 },
    enabled: true,
    version: '1.0.0',
  },
  web_search: {
    name: 'web_search',
    description: 'Search the web using Gemini with Google Search grounding.',
    riskLevel: 'low',
    rateLimit: { maxPerMinute: 20, burst: 5 },
    enabled: true,
    version: '1.0.0',
  },
  web_fetch: {
    name: 'web_fetch',
    description: 'Fetch and extract readable content from HTTP/HTTPS URLs.',
    riskLevel: 'low',
    rateLimit: { maxPerMinute: 60, burst: 10 },
    enabled: true,
    version: '1.0.0',
  },
  image: {
    name: 'image',
    description: 'Analyze images with the configured image model.',
    riskLevel: 'low',
    rateLimit: { maxPerMinute: 30, burst: 5 },
    enabled: true,
    version: '1.0.0',
  },
  video: {
    name: 'video',
    description: 'Generate videos using configured providers.',
    riskLevel: 'low',
    rateLimit: { maxPerMinute: 10, burst: 2 },
    enabled: true,
    version: '1.0.0',
  },
  music: {
    name: 'music',
    description: 'Generate music using configured providers.',
    riskLevel: 'low',
    rateLimit: { maxPerMinute: 10, burst: 2 },
    enabled: true,
    version: '1.0.0',
  },
};

// Mutable copy exposed for runtime updates via PATCH
let registry = { ...tools };

function getAllTools() {
  return Object.values(registry);
}

function getTool(name) {
  return registry[name] || null;
}

function updateTool(name, changes) {
  if (!registry[name]) return null;
  registry[name] = { ...registry[name], ...changes };
  return registry[name];
}

function resetRegistry() {
  registry = { ...tools };
}

module.exports = { getAllTools, getTool, updateTool, resetRegistry };

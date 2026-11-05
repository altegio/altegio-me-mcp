// Runs before every test file (Jest setupFilesAfterEnv).
// Fixed values keep tests independent of the developer's environment. The
// opt-in live suite (ALTEGIO_E2E=1, npm run test:live) is the exception, as in
// Altegio.Pro MCP: it keeps the real partner token and API base from .env.
if (process.env.ALTEGIO_E2E === '1') {
  const base = process.env.ALTEGIO_API_BASE;
  if (base === undefined || base === '') {
    process.env.ALTEGIO_API_BASE = 'https://api.alteg.io/api/v1';
  }
} else {
  for (const key of Object.keys(process.env)) {
    if (/^(ALTEGIO_|MCP_PROXY_|CONFIRMATION_SECRET)/.test(key))
      delete process.env[key];
  }
  process.env.ALTEGIO_API_TOKEN = 'test-partner-token';
  process.env.ALTEGIO_API_BASE = 'https://api.alteg.io/api/v1';
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

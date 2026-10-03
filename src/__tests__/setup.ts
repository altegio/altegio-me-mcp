// Runs before every test file (Jest setupFilesAfterEnv).
// Fixed values keep tests independent of the developer's environment.
process.env.ALTEGIO_API_TOKEN = 'test-partner-token';
process.env.ALTEGIO_API_BASE = 'https://api.alteg.io/api/v1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

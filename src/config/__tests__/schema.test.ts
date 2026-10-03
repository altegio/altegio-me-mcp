import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  CONFIG_KEYS,
  ConfigError,
  formatConfigError,
  loadConfig,
} from '../schema.js';

const VALID: Record<string, string> = {
  ALTEGIO_API_TOKEN: 'partner-token-value',
  PUBLIC_BASE_URL: 'https://mcp.example.com',
};

function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function readEnvExample(): Record<string, string> {
  const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  return parseDotenv(text);
}

function configErrorFor(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig did not throw');
}

function issueKeys(env: Record<string, string | undefined>): string[] {
  return configErrorFor(env).issues.map((issue) => issue.key);
}

describe('.env.example', () => {
  it('starts the server unchanged and yields the documented defaults', () => {
    const config = loadConfig(readEnvExample());
    expect(config.PORT).toBe(8080);
    expect(config.ALTEGIO_API_BASE).toBe('https://api.alteg.io/api/v1');
    expect(config.ALTEGIO_API_TOKEN).toBe('your_partner_token_here');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.NODE_ENV).toBe('development');
  });

  it('lists exactly the config keys', () => {
    expect(Object.keys(readEnvExample()).sort()).toEqual(
      [...CONFIG_KEYS].sort()
    );
  });
});

describe('loadConfig defaults and required keys', () => {
  it('reports only the token and the public URL for an empty environment', () => {
    const error = configErrorFor({});
    expect(error.issues.map((issue) => issue.key)).toEqual([
      'ALTEGIO_API_TOKEN',
      'PUBLIC_BASE_URL',
    ]);
  });

  it('applies defaults when only the required keys are set', () => {
    expect(loadConfig(VALID)).toEqual({
      PORT: 8080,
      ALTEGIO_API_BASE: 'https://api.alteg.io/api/v1',
      ALTEGIO_API_TOKEN: 'partner-token-value',
      PUBLIC_BASE_URL: 'https://mcp.example.com',
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
    });
  });

  it('treats an empty string as unset', () => {
    expect(loadConfig({ ...VALID, PORT: '' }).PORT).toBe(8080);
    const missingToken = configErrorFor({ ...VALID, ALTEGIO_API_TOKEN: '' });
    expect(missingToken.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: 'Partner API token is required' },
    ]);
  });

  it('treats a whitespace-only token as missing', () => {
    const error = configErrorFor({ ...VALID, ALTEGIO_API_TOKEN: '   ' });
    expect(error.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: 'Partner API token is required' },
    ]);
  });

  it('gives a missing token the same message as an empty one', () => {
    const error = configErrorFor({ PUBLIC_BASE_URL: VALID.PUBLIC_BASE_URL });
    expect(error.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: 'Partner API token is required' },
    ]);
  });

  it('accepts any non-empty token, including one character', () => {
    expect(loadConfig({ ...VALID, ALTEGIO_API_TOKEN: 'x' })).toMatchObject({
      ALTEGIO_API_TOKEN: 'x',
    });
  });

  it('trims values before validation', () => {
    const config = loadConfig({
      ...VALID,
      PORT: ' 8080 ',
      ALTEGIO_API_TOKEN: '  padded-token  ',
    });
    expect(config.PORT).toBe(8080);
    expect(config.ALTEGIO_API_TOKEN).toBe('padded-token');
  });
});

describe('loadConfig PORT', () => {
  it.each(['1', '65535', ' 8080 ', '3000'])('accepts %j', (port) => {
    expect(loadConfig({ ...VALID, PORT: port }).PORT).toBe(Number(port.trim()));
  });

  it.each(['0', '65536', 'abc', '80.5', '-1', '0x1F90', '1e3'])(
    'rejects %j with a PORT issue',
    (port) => {
      expect(issueKeys({ ...VALID, PORT: port })).toEqual(['PORT']);
    }
  );
});

describe('loadConfig URLs and enums', () => {
  it.each(['not a url', 'ftp://example.com', 'example.com'])(
    'rejects PUBLIC_BASE_URL %j',
    (url) => {
      expect(issueKeys({ ...VALID, PUBLIC_BASE_URL: url })).toEqual([
        'PUBLIC_BASE_URL',
      ]);
    }
  );

  it.each(['not a url', 'ftp://example.com'])(
    'rejects ALTEGIO_API_BASE %j',
    (url) => {
      expect(issueKeys({ ...VALID, ALTEGIO_API_BASE: url })).toEqual([
        'ALTEGIO_API_BASE',
      ]);
    }
  );

  it('accepts http and https URLs', () => {
    const config = loadConfig({
      ...VALID,
      PUBLIC_BASE_URL: 'http://localhost:8080',
      ALTEGIO_API_BASE: 'http://localhost:9000/api/v1',
    });
    expect(config.PUBLIC_BASE_URL).toBe('http://localhost:8080');
    expect(config.ALTEGIO_API_BASE).toBe('http://localhost:9000/api/v1');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(issueKeys({ ...VALID, LOG_LEVEL: 'verbose' })).toEqual([
      'LOG_LEVEL',
    ]);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(issueKeys({ ...VALID, NODE_ENV: 'staging' })).toEqual(['NODE_ENV']);
  });

  it.each(['development', 'test', 'production'])(
    'accepts NODE_ENV %s',
    (nodeEnv) => {
      expect(loadConfig({ ...VALID, NODE_ENV: nodeEnv }).NODE_ENV).toBe(
        nodeEnv
      );
    }
  );
});

describe('ConfigError reporting', () => {
  it('reports several invalid variables once each, in CONFIG_KEYS order', () => {
    const error = configErrorFor({
      NODE_ENV: 'staging',
      LOG_LEVEL: 'verbose',
      PUBLIC_BASE_URL: 'nope',
      ALTEGIO_API_TOKEN: '',
      ALTEGIO_API_BASE: 'nope',
      PORT: 'abc',
    });
    expect(error.issues.map((issue) => issue.key)).toEqual([...CONFIG_KEYS]);
  });

  it('formats the failure as a header, one line per issue and a pointer', () => {
    const error = configErrorFor({
      PORT: 'abc',
      PUBLIC_BASE_URL: 'nope',
    });
    const lines = formatConfigError(error).split('\n');
    expect(lines[0]).toBe('Invalid configuration:');
    expect(lines.slice(1, -1)).toEqual(
      error.issues.map((issue) => `  - ${issue.key}: ${issue.message}`)
    );
    expect(lines.slice(1, -1).map((line) => line.split(':')[0])).toEqual([
      '  - PORT',
      '  - ALTEGIO_API_TOKEN',
      '  - PUBLIC_BASE_URL',
    ]);
    expect(lines.at(-1)).toBe('See .env.example');
  });

  it('never echoes an input value', () => {
    const canary = 'CANARY-7f3a91-do-not-print';
    const error = configErrorFor({
      ...VALID,
      PUBLIC_BASE_URL: `${canary}-url`,
      PORT: `${canary}-port`,
      LOG_LEVEL: `${canary}-level`,
      NODE_ENV: `${canary}-env`,
      ALTEGIO_API_BASE: `${canary}-base`,
    });
    const text = `${formatConfigError(error)}\n${error.message}\n${JSON.stringify(
      error.issues
    )}`;
    expect(text).not.toContain('CANARY');
    expect(text).not.toContain(VALID.ALTEGIO_API_TOKEN);
  });

  it('gives each issue a fixed, non-empty message', () => {
    const error = configErrorFor({});
    for (const issue of error.issues) {
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  CONFIG_KEYS,
  ConfigError,
  formatConfigError,
  loadConfig,
} from '../schema.js';

// PROXY_AUTH defaults to required, which fails without a proxy key, so the
// shared fixture turns it off explicitly; the proxy-key cases set it themselves.
const VALID: Record<string, string> = {
  ALTEGIO_API_TOKEN: 'partner-token-value',
  PUBLIC_BASE_URL: 'https://mcp.example.com',
  PROXY_AUTH: 'off',
};

const PROXY_KEY = 'proxy-key-0123456789abcdef0123456789abcdef';

// One fixed message names both settings and no value (OPS-04, D-05).
const TOKEN_REQUIRED =
  'Partner API token is required (ALTEGIO_API_TOKEN or ALTEGIO_API_TOKEN_FILE)';

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
    expect(config.ALTEGIO_APP_BASE).toBe('https://app.alteg.io');
    expect(config.MARKETPLACE_APPLICATION_ID).toBeUndefined();
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
    const error = configErrorFor({ PROXY_AUTH: 'off' });
    expect(error.issues.map((issue) => issue.key)).toEqual([
      'ALTEGIO_API_TOKEN',
      'PUBLIC_BASE_URL',
    ]);
  });

  it('applies defaults when only the required keys are set', () => {
    expect(loadConfig(VALID)).toEqual({
      PORT: 8080,
      ALTEGIO_API_BASE: 'https://api.alteg.io/api/v1',
      ALTEGIO_APP_BASE: 'https://app.alteg.io',
      ALTEGIO_API_TOKEN: 'partner-token-value',
      PUBLIC_BASE_URL: 'https://mcp.example.com',
      LOG_LEVEL: 'info',
      NODE_ENV: 'production',
      PROXY_AUTH: 'off',
      CALLER_AUTH: 'required',
      CLIENT_USER_TOKEN_HEADER: 'x-mcp-auth-altegio-user-token',
      CLIENT_SCOPE_HEADER: 'x-mcp-auth-scope',
      CLIENT_CALLER_KIND: 'client',
      TRUSTED_PROXY_HOPS: 1,
      SHARED_EGRESS_CIDRS: ['160.79.104.0/21'],
      EXTRA_ALLOWED_ORIGINS: ['https://claude.ai', 'https://claude.com'],
      EXTRA_ALLOWED_HOSTS: [],
      EDGE_MAX_INFLIGHT: 60,
      EDGE_MAX_INFLIGHT_PER_IP: 6,
      EDGE_IP_BURST: 40,
      EDGE_IP_REFILL_PER_SEC: 3,
      EDGE_POOL_BURST: 200,
      EDGE_POOL_REFILL_PER_SEC: 20,
      GATE_MAX_QUEUE_PER_KEY: 8,
    });
  });

  it('defaults NODE_ENV to production so an unset deployment runs closed', () => {
    expect(loadConfig(VALID).NODE_ENV).toBe('production');
  });

  it('treats an empty string as unset', () => {
    expect(loadConfig({ ...VALID, PORT: '' }).PORT).toBe(8080);
    const missingToken = configErrorFor({ ...VALID, ALTEGIO_API_TOKEN: '' });
    expect(missingToken.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: TOKEN_REQUIRED },
    ]);
  });

  it('treats a whitespace-only token as missing', () => {
    const error = configErrorFor({ ...VALID, ALTEGIO_API_TOKEN: '   ' });
    expect(error.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: TOKEN_REQUIRED },
    ]);
  });

  it('gives a missing token the same message as an empty one', () => {
    const error = configErrorFor({
      PUBLIC_BASE_URL: VALID.PUBLIC_BASE_URL,
      PROXY_AUTH: 'off',
    });
    expect(error.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: TOKEN_REQUIRED },
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

  it.each(['not a url', 'ftp://example.com'])(
    'rejects ALTEGIO_APP_BASE %j',
    (url) => {
      expect(issueKeys({ ...VALID, ALTEGIO_APP_BASE: url })).toEqual([
        'ALTEGIO_APP_BASE',
      ]);
    }
  );

  it('requires https for ALTEGIO_APP_BASE in production', () => {
    expect(
      issueKeys({
        ...VALID,
        NODE_ENV: 'production',
        ALTEGIO_APP_BASE: 'http://app.example.test',
      })
    ).toEqual(['ALTEGIO_APP_BASE']);
  });

  it('reads MARKETPLACE_APPLICATION_ID as a positive integer, or leaves the gate off', () => {
    expect(
      loadConfig({ ...VALID, MARKETPLACE_APPLICATION_ID: '2642' })
        .MARKETPLACE_APPLICATION_ID
    ).toBe(2642);
    expect(
      loadConfig({ ...VALID, MARKETPLACE_APPLICATION_ID: '' })
        .MARKETPLACE_APPLICATION_ID
    ).toBeUndefined();
    for (const bad of ['0', '-1', '2642.5', 'abc']) {
      expect(issueKeys({ ...VALID, MARKETPLACE_APPLICATION_ID: bad })).toEqual([
        'MARKETPLACE_APPLICATION_ID',
      ]);
    }
  });

  it('accepts http and https URLs outside production', () => {
    const config = loadConfig({
      ...VALID,
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:8080',
      ALTEGIO_API_BASE: 'http://localhost:9000/api/v1',
    });
    expect(config.PUBLIC_BASE_URL).toBe('http://localhost:8080');
    expect(config.ALTEGIO_API_BASE).toBe('http://localhost:9000/api/v1');
  });

  it.each(['development', 'test'])(
    'accepts an http ALTEGIO_API_BASE when NODE_ENV is %s',
    (nodeEnv) => {
      expect(
        loadConfig({
          ...VALID,
          NODE_ENV: nodeEnv,
          ALTEGIO_API_BASE: 'http://localhost:9000/api/v1',
        }).ALTEGIO_API_BASE
      ).toBe('http://localhost:9000/api/v1');
    }
  );

  it.each([{ NODE_ENV: 'production' }, {}])(
    'rejects an http ALTEGIO_API_BASE in production (%j) with a fixed message',
    (nodeEnv) => {
      const base = 'http://api.example.com/api/v1';
      const error = configErrorFor({
        ...VALID,
        ...nodeEnv,
        ALTEGIO_API_BASE: base,
      });
      expect(error.issues).toEqual([
        {
          key: 'ALTEGIO_API_BASE',
          message:
            'must be an https URL (http is accepted only when NODE_ENV is development or test)',
        },
      ]);
      expect(formatConfigError(error)).not.toContain('api.example.com');
    }
  );

  it('reports an http ALTEGIO_API_BASE in production alongside other issues', () => {
    expect(
      issueKeys({
        ALTEGIO_API_TOKEN: VALID.ALTEGIO_API_TOKEN,
        ALTEGIO_API_BASE: 'http://api.example.com/api/v1',
        LOG_LEVEL: 'verbose',
        PROXY_AUTH: 'off',
      })
    ).toEqual(['ALTEGIO_API_BASE', 'PUBLIC_BASE_URL', 'LOG_LEVEL']);
  });

  it('keeps the https default for ALTEGIO_API_BASE in production', () => {
    expect(
      loadConfig({ ...VALID, NODE_ENV: 'production' }).ALTEGIO_API_BASE
    ).toBe('https://api.alteg.io/api/v1');
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

describe('the client sign-in settings (ADR 0005, D-01)', () => {
  it('lower-cases a header name and keeps the kind as written', () => {
    expect(
      loadConfig({
        ...VALID,
        CLIENT_USER_TOKEN_HEADER: 'X-Mcp-Auth-User',
        CLIENT_SCOPE_HEADER: 'X-MCP-Auth-Scopes',
        CLIENT_CALLER_KIND: 'enduser',
      })
    ).toMatchObject({
      CLIENT_USER_TOKEN_HEADER: 'x-mcp-auth-user',
      CLIENT_SCOPE_HEADER: 'x-mcp-auth-scopes',
      CLIENT_CALLER_KIND: 'enduser',
    });
  });

  it.each([
    ['CLIENT_USER_TOKEN_HEADER', 'x-altegio-user'],
    ['CLIENT_USER_TOKEN_HEADER', 'x-mcp-auth-'],
    ['CLIENT_USER_TOKEN_HEADER', 'x-mcp-auth-user token'],
    ['CLIENT_USER_TOKEN_HEADER', 'x-mcp-auth-kind'],
    ['CLIENT_USER_TOKEN_HEADER', 'x-mcp-auth-altegio-partner-token'],
    ['CLIENT_SCOPE_HEADER', 'scope'],
    ['CLIENT_SCOPE_HEADER', 'x-mcp-auth-kind'],
    ['CLIENT_CALLER_KIND', 'partner'],
    ['CLIENT_CALLER_KIND', 'Client Kind'],
    ['CLIENT_CALLER_KIND', ''.padEnd(40, 'a')],
  ])('rejects %s = %s with the fixed rule text', (key, value) => {
    const error = configErrorFor({ ...VALID, [key]: value });
    expect(error.issues.map((issue) => issue.key)).toEqual([key]);
    expect(error.issues[0]?.message).toMatch(/x-mcp-auth-|partner/);
  });

  it.each([
    'CLIENT_USER_TOKEN_HEADER',
    'CLIENT_SCOPE_HEADER',
    'CLIENT_CALLER_KIND',
  ])('never echoes the value of %s', (key) => {
    const canary = 'CANARY-7f3a91-do-not-print';
    const error = configErrorFor({ ...VALID, [key]: canary });
    expect(error.issues.map((issue) => issue.key)).toEqual([key]);
    expect(formatConfigError(error)).not.toContain(canary);
    expect(formatConfigError(error)).not.toContain(canary.toLowerCase());
  });

  it('rejects a scope header equal to the default user token header', () => {
    expect(
      issueKeys({
        ...VALID,
        CLIENT_SCOPE_HEADER: 'x-mcp-auth-altegio-user-token',
      }).sort()
    ).toEqual(['CLIENT_SCOPE_HEADER', 'CLIENT_USER_TOKEN_HEADER']);
  });

  it('rejects the same header name for the user token and the scope list', () => {
    expect(
      issueKeys({
        ...VALID,
        CLIENT_USER_TOKEN_HEADER: 'x-mcp-auth-same',
        CLIENT_SCOPE_HEADER: 'x-mcp-auth-same',
      }).sort()
    ).toEqual(['CLIENT_SCOPE_HEADER', 'CLIENT_USER_TOKEN_HEADER']);
  });
});

describe('CONFIRMATION_SECRET (ADR 0006, D-03)', () => {
  const GOOD = 'confirmation-secret-0123456789abcdef0123';

  it('is undefined when unset or empty', () => {
    expect(loadConfig(VALID).CONFIRMATION_SECRET).toBeUndefined();
    expect(
      loadConfig({ ...VALID, CONFIRMATION_SECRET: '   ' }).CONFIRMATION_SECRET
    ).toBeUndefined();
  });

  it('accepts 32 printable characters and up to 512', () => {
    expect(
      loadConfig({ ...VALID, CONFIRMATION_SECRET: 'a'.repeat(32) })
        .CONFIRMATION_SECRET
    ).toBe('a'.repeat(32));
    expect(
      loadConfig({ ...VALID, CONFIRMATION_SECRET: GOOD }).CONFIRMATION_SECRET
    ).toBe(GOOD);
    expect(
      issueKeys({ ...VALID, CONFIRMATION_SECRET: 'a'.repeat(513) })
    ).toEqual(['CONFIRMATION_SECRET']);
  });

  it.each([
    ['shorter than 32 characters', 'a'.repeat(31)],
    ['holding a space', `${'a'.repeat(20)} ${'b'.repeat(20)}`],
    ['holding a control character', `${'a'.repeat(40)}\u0007`],
    ['holding a non-ASCII character', `${'a'.repeat(40)}\u00e9`],
  ])(
    'rejects a value %s, naming the key and never the value',
    (_label, value) => {
      const error = configErrorFor({ ...VALID, CONFIRMATION_SECRET: value });
      expect(error.issues.map((issue) => issue.key)).toEqual([
        'CONFIRMATION_SECRET',
      ]);
      const text = formatConfigError(error);
      expect(text).toContain('CONFIRMATION_SECRET');
      expect(text).toContain('32');
      expect(text).not.toContain(value);
    }
  );
});

describe('ConfigError reporting', () => {
  it('reports several invalid variables once each, in CONFIG_KEYS order', () => {
    const error = configErrorFor({
      NODE_ENV: 'staging',
      LOG_LEVEL: 'verbose',
      PUBLIC_BASE_URL: 'nope',
      // Any non-empty token is valid, so this key is the one that cannot fail
      // while a token file is named.
      ALTEGIO_API_TOKEN: 'x',
      ALTEGIO_API_TOKEN_FILE: 'relative/token',
      ALTEGIO_API_BASE: 'nope',
      ALTEGIO_APP_BASE: 'nope',
      PORT: 'abc',
      PROXY_AUTH: 'maybe',
      MCP_PROXY_BACKEND_KEY: 'short',
      MCP_PROXY_BACKEND_KEY_FILE: 'relative/path',
      CALLER_AUTH: 'sometimes',
      CLIENT_USER_TOKEN_HEADER: 'x-altegio-user',
      CLIENT_SCOPE_HEADER: 'x-mcp-auth-',
      CLIENT_CALLER_KIND: 'partner',
      CONFIRMATION_SECRET: 'short',
      COMMIT_SHA: 'NOT-HEX',
      TRUSTED_PROXY_HOPS: '-1',
      SHARED_EGRESS_CIDRS: 'not-a-cidr',
      EXTRA_ALLOWED_ORIGINS: 'ftp://x',
      EXTRA_ALLOWED_HOSTS: '*.invalid',
      EDGE_MAX_INFLIGHT: '0',
      EDGE_MAX_INFLIGHT_PER_IP: '0',
      EDGE_IP_BURST: '0',
      EDGE_IP_REFILL_PER_SEC: '0',
      EDGE_POOL_BURST: '0',
      EDGE_POOL_REFILL_PER_SEC: '0',
      GATE_MAX_QUEUE_PER_KEY: '0',
      MARKETPLACE_APPLICATION_ID: 'abc',
    });
    expect(error.issues.map((issue) => issue.key)).toEqual(
      CONFIG_KEYS.filter((key) => key !== 'ALTEGIO_API_TOKEN')
    );
  });

  it('formats the failure as a header, one line per issue and a pointer', () => {
    const error = configErrorFor({
      PORT: 'abc',
      PUBLIC_BASE_URL: 'nope',
      PROXY_AUTH: 'off',
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
      ALTEGIO_API_TOKEN_FILE: `${canary}-token-file`,
      PROXY_AUTH: `${canary}-auth`,
      MCP_PROXY_BACKEND_KEY: `${canary}`,
      MCP_PROXY_BACKEND_KEY_FILE: `${canary}-file`,
      COMMIT_SHA: `${canary}-sha`,
      TRUSTED_PROXY_HOPS: `${canary}-hops`,
      SHARED_EGRESS_CIDRS: `${canary}-cidr`,
      EXTRA_ALLOWED_ORIGINS: `${canary}-origins`,
      EDGE_MAX_INFLIGHT: `${canary}-a`,
      EDGE_MAX_INFLIGHT_PER_IP: `${canary}-b`,
      EDGE_IP_BURST: `${canary}-c`,
      EDGE_IP_REFILL_PER_SEC: `${canary}-d`,
      EDGE_POOL_BURST: `${canary}-e`,
      EDGE_POOL_REFILL_PER_SEC: `${canary}-f`,
      GATE_MAX_QUEUE_PER_KEY: `${canary}-g`,
    });
    const text = `${formatConfigError(error)}\n${error.message}\n${JSON.stringify(
      error.issues
    )}`;
    expect(text).not.toContain('CANARY');
    expect(text).not.toContain(VALID.ALTEGIO_API_TOKEN);
  });

  it('gives each issue a fixed, non-empty message', () => {
    const error = configErrorFor({ PROXY_AUTH: 'maybe' });
    for (const issue of error.issues) {
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

describe('loadConfig proxy signature settings (OPS-03, D-04)', () => {
  const WITHOUT_PROXY_SETTING: Record<string, string> = {
    ALTEGIO_API_TOKEN: VALID.ALTEGIO_API_TOKEN ?? '',
    PUBLIC_BASE_URL: VALID.PUBLIC_BASE_URL ?? '',
  };

  it('defaults PROXY_AUTH to required', () => {
    expect(
      loadConfig({ ...WITHOUT_PROXY_SETTING, MCP_PROXY_BACKEND_KEY: PROXY_KEY })
        .PROXY_AUTH
    ).toBe('required');
  });

  it('fails without PROXY_AUTH and without either key setting, with a fixed message', () => {
    const error = configErrorFor(WITHOUT_PROXY_SETTING);
    expect(error.issues).toEqual([
      {
        key: 'MCP_PROXY_BACKEND_KEY_FILE',
        message:
          'is required when PROXY_AUTH is required: set it to the path of the mounted proxy key file (or set MCP_PROXY_BACKEND_KEY; local runs set PROXY_AUTH=off)',
      },
    ]);
    const text = `${formatConfigError(error)}\n${error.message}`;
    expect(text).toContain('MCP_PROXY_BACKEND_KEY_FILE');
    expect(text).not.toContain(WITHOUT_PROXY_SETTING.ALTEGIO_API_TOKEN ?? '');
  });

  it('treats an empty key and an empty file path as not set', () => {
    expect(
      issueKeys({
        ...WITHOUT_PROXY_SETTING,
        MCP_PROXY_BACKEND_KEY: '',
        MCP_PROXY_BACKEND_KEY_FILE: '  ',
      })
    ).toEqual(['MCP_PROXY_BACKEND_KEY_FILE']);
  });

  it('accepts a key file path', () => {
    const config = loadConfig({
      ...WITHOUT_PROXY_SETTING,
      MCP_PROXY_BACKEND_KEY_FILE: '/secrets/proxy-key/key',
    });
    expect(config.PROXY_AUTH).toBe('required');
    expect(config.MCP_PROXY_BACKEND_KEY_FILE).toBe('/secrets/proxy-key/key');
  });

  it('accepts a key of 32 or more characters, also inside a rotation list', () => {
    expect(
      loadConfig({ ...WITHOUT_PROXY_SETTING, MCP_PROXY_BACKEND_KEY: PROXY_KEY })
        .MCP_PROXY_BACKEND_KEY
    ).toBe(PROXY_KEY);
    expect(
      loadConfig({
        ...WITHOUT_PROXY_SETTING,
        MCP_PROXY_BACKEND_KEY: `short,${PROXY_KEY}`,
      }).MCP_PROXY_BACKEND_KEY
    ).toBe(`short,${PROXY_KEY}`);
  });

  it('rejects a key setting with no key of 32 characters, without echoing it', () => {
    const short = 'too-short-key-value';
    const error = configErrorFor({
      ...WITHOUT_PROXY_SETTING,
      MCP_PROXY_BACKEND_KEY: short,
    });
    expect(error.issues).toEqual([
      {
        key: 'MCP_PROXY_BACKEND_KEY',
        message: 'must hold at least one key of 32 or more characters',
      },
    ]);
    expect(formatConfigError(error)).not.toContain(short);
  });

  it('rejects a relative key file path', () => {
    expect(
      issueKeys({
        ...WITHOUT_PROXY_SETTING,
        MCP_PROXY_BACKEND_KEY_FILE: 'secrets/key',
      })
    ).toEqual(['MCP_PROXY_BACKEND_KEY_FILE']);
  });

  it('needs no key when PROXY_AUTH is explicitly off', () => {
    expect(
      loadConfig({ ...WITHOUT_PROXY_SETTING, PROXY_AUTH: 'off' })
    ).toMatchObject({ PROXY_AUTH: 'off' });
  });

  it('rejects an unknown PROXY_AUTH value instead of treating it as off', () => {
    expect(
      issueKeys({
        ...WITHOUT_PROXY_SETTING,
        PROXY_AUTH: 'false',
        MCP_PROXY_BACKEND_KEY: PROXY_KEY,
      })
    ).toEqual(['PROXY_AUTH']);
  });

  it.each(['0123abc', 'a'.repeat(40)])('accepts COMMIT_SHA %j', (sha) => {
    expect(loadConfig({ ...VALID, COMMIT_SHA: sha }).COMMIT_SHA).toBe(sha);
  });

  it.each(['0123ab', 'a'.repeat(41), '0123ABC', 'zzzzzzz'])(
    'rejects COMMIT_SHA %j',
    (sha) => {
      expect(issueKeys({ ...VALID, COMMIT_SHA: sha })).toEqual(['COMMIT_SHA']);
    }
  );

  it('treats an empty COMMIT_SHA as unset', () => {
    expect(loadConfig({ ...VALID, COMMIT_SHA: '' }).COMMIT_SHA).toBeUndefined();
  });
});

describe('loadConfig proxy settings: closed value sets and fixed messages', () => {
  const WITH_KEY: Record<string, string> = {
    ALTEGIO_API_TOKEN: VALID.ALTEGIO_API_TOKEN ?? '',
    PUBLIC_BASE_URL: VALID.PUBLIC_BASE_URL ?? '',
    MCP_PROXY_BACKEND_KEY: PROXY_KEY,
  };

  it.each(['required', 'off'])('accepts PROXY_AUTH %j', (mode) => {
    expect(loadConfig({ ...WITH_KEY, PROXY_AUTH: mode }).PROXY_AUTH).toBe(mode);
  });

  it.each(['on', 'true', 'false', '0', '1', 'OFF', 'Required', 'disabled'])(
    'rejects PROXY_AUTH %j instead of reading it as off, with a fixed message',
    (mode) => {
      const error = configErrorFor({ ...WITH_KEY, PROXY_AUTH: mode });
      expect(error.issues).toEqual([
        { key: 'PROXY_AUTH', message: 'must be one of required, off' },
      ]);
    }
  );

  it.each(['/secrets/proxy-key/key', '/run/secrets/k'])(
    'accepts the absolute MCP_PROXY_BACKEND_KEY_FILE %j',
    (path) => {
      expect(
        loadConfig({
          ALTEGIO_API_TOKEN: VALID.ALTEGIO_API_TOKEN ?? '',
          PUBLIC_BASE_URL: VALID.PUBLIC_BASE_URL ?? '',
          MCP_PROXY_BACKEND_KEY_FILE: path,
        }).MCP_PROXY_BACKEND_KEY_FILE
      ).toBe(path);
    }
  );

  it.each(['key', './key', '../key', '~/key', 'secrets/proxy-key/key'])(
    'rejects the relative MCP_PROXY_BACKEND_KEY_FILE %j with a fixed message',
    (path) => {
      const error = configErrorFor({
        ...VALID,
        MCP_PROXY_BACKEND_KEY_FILE: path,
      });
      expect(error.issues).toEqual([
        {
          key: 'MCP_PROXY_BACKEND_KEY_FILE',
          message: 'must be an absolute file path',
        },
      ]);
      expect(formatConfigError(error)).not.toContain(path);
    }
  );

  it('rejects a key list that holds only keys shorter than 32 characters', () => {
    const shortList = `${'a'.repeat(31)},${'b'.repeat(10)}`;
    const error = configErrorFor({
      ...VALID,
      PROXY_AUTH: 'required',
      MCP_PROXY_BACKEND_KEY: shortList,
    });
    expect(error.issues).toEqual([
      {
        key: 'MCP_PROXY_BACKEND_KEY',
        message: 'must hold at least one key of 32 or more characters',
      },
    ]);
    expect(formatConfigError(error)).not.toContain('aaaa');
  });

  it('accepts a key of exactly 32 characters', () => {
    expect(
      loadConfig({
        ...VALID,
        PROXY_AUTH: 'required',
        MCP_PROXY_BACKEND_KEY: 'k'.repeat(32),
      }).MCP_PROXY_BACKEND_KEY
    ).toBe('k'.repeat(32));
  });

  it('rejects COMMIT_SHA with a fixed message that never echoes it', () => {
    const sha = 'NOT-A-HEX-VALUE';
    const error = configErrorFor({ ...VALID, COMMIT_SHA: sha });
    expect(error.issues).toEqual([
      {
        key: 'COMMIT_SHA',
        message: 'must be 7 to 40 lowercase hexadecimal characters',
      },
    ]);
    expect(formatConfigError(error)).not.toContain(sha);
  });

  it('never echoes a key, a path or a commit through any message of one failing run', () => {
    const canary = 'canary-key-9d4e71c2b8a6-do-not-print';
    const error = configErrorFor({
      ...VALID,
      PROXY_AUTH: 'required',
      MCP_PROXY_BACKEND_KEY: canary.slice(0, 20),
      MCP_PROXY_BACKEND_KEY_FILE: `relative/${canary}`,
      COMMIT_SHA: canary,
    });
    const text = `${formatConfigError(error)}\n${error.message}\n${JSON.stringify(
      error.issues
    )}`;
    expect(text).not.toContain('canary');
    expect(text).not.toContain('do-not-print');
  });
});

describe('loadConfig partner token settings (OPS-04, D-05)', () => {
  const WITHOUT_TOKEN: Record<string, string> = {
    PUBLIC_BASE_URL: VALID.PUBLIC_BASE_URL ?? '',
    PROXY_AUTH: 'off',
  };
  const TOKEN_FILE = '/secrets/altegio-api/token';

  it('accepts ALTEGIO_API_TOKEN_FILE without ALTEGIO_API_TOKEN', () => {
    const config = loadConfig({
      ...WITHOUT_TOKEN,
      ALTEGIO_API_TOKEN_FILE: TOKEN_FILE,
    });
    expect(config.ALTEGIO_API_TOKEN_FILE).toBe(TOKEN_FILE);
    expect(config.ALTEGIO_API_TOKEN).toBeUndefined();
  });

  it('accepts both settings and keeps both values (the file wins in src/server.ts)', () => {
    const config = loadConfig({
      ...VALID,
      ALTEGIO_API_TOKEN_FILE: TOKEN_FILE,
    });
    expect(config.ALTEGIO_API_TOKEN).toBe('partner-token-value');
    expect(config.ALTEGIO_API_TOKEN_FILE).toBe(TOKEN_FILE);
  });

  it('fails with neither setting, one issue that names both settings and no value', () => {
    const error = configErrorFor(WITHOUT_TOKEN);
    expect(error.issues).toEqual([
      { key: 'ALTEGIO_API_TOKEN', message: TOKEN_REQUIRED },
    ]);
    expect(formatConfigError(error)).toContain(
      '  - ALTEGIO_API_TOKEN: Partner API token is required (ALTEGIO_API_TOKEN or ALTEGIO_API_TOKEN_FILE)'
    );
  });

  it('treats an empty or blank file path as not set', () => {
    for (const blank of ['', '   ']) {
      expect(
        configErrorFor({ ...WITHOUT_TOKEN, ALTEGIO_API_TOKEN_FILE: blank })
          .issues
      ).toEqual([{ key: 'ALTEGIO_API_TOKEN', message: TOKEN_REQUIRED }]);
      expect(
        loadConfig({ ...VALID, ALTEGIO_API_TOKEN_FILE: blank })
          .ALTEGIO_API_TOKEN_FILE
      ).toBeUndefined();
    }
  });

  it.each(['token', './token', '../token', '~/token', 'secrets/token'])(
    'rejects the relative path %s with a fixed message, whether or not a plain token is set',
    (path) => {
      const expected = [
        {
          key: 'ALTEGIO_API_TOKEN_FILE',
          message: 'must be an absolute file path',
        },
      ];
      expect(
        configErrorFor({ ...VALID, ALTEGIO_API_TOKEN_FILE: path }).issues
      ).toEqual(expected);
      expect(
        configErrorFor({ ...WITHOUT_TOKEN, ALTEGIO_API_TOKEN_FILE: path })
          .issues
      ).toEqual(expected);
    }
  );

  it('keeps the rule for ALTEGIO_API_TOKEN: any non-empty string, as in Altegio.Pro MCP', () => {
    expect(
      loadConfig({ ...WITHOUT_TOKEN, ALTEGIO_API_TOKEN: 'x' })
    ).toMatchObject({ ALTEGIO_API_TOKEN: 'x' });
  });
});

describe('loadConfig edge protection and origin settings (OPS-06, OPS-08)', () => {
  const POSITIVE_INTEGERS = [
    'EDGE_MAX_INFLIGHT',
    'EDGE_MAX_INFLIGHT_PER_IP',
    'EDGE_IP_BURST',
    'EDGE_POOL_BURST',
    'GATE_MAX_QUEUE_PER_KEY',
  ] as const;
  const POSITIVE_NUMBERS = [
    'EDGE_IP_REFILL_PER_SEC',
    'EDGE_POOL_REFILL_PER_SEC',
  ] as const;

  it('loads the documented defaults from .env.example', () => {
    expect(loadConfig(readEnvExample())).toMatchObject({
      TRUSTED_PROXY_HOPS: 1,
      SHARED_EGRESS_CIDRS: ['160.79.104.0/21'],
      EXTRA_ALLOWED_ORIGINS: ['https://claude.ai', 'https://claude.com'],
      EXTRA_ALLOWED_HOSTS: [],
      EDGE_MAX_INFLIGHT: 60,
      EDGE_MAX_INFLIGHT_PER_IP: 6,
      EDGE_IP_BURST: 40,
      EDGE_IP_REFILL_PER_SEC: 3,
      EDGE_POOL_BURST: 200,
      EDGE_POOL_REFILL_PER_SEC: 20,
      GATE_MAX_QUEUE_PER_KEY: 8,
    });
  });

  it.each(POSITIVE_INTEGERS)('accepts %s as a positive integer', (key) => {
    expect(loadConfig({ ...VALID, [key]: '12' })).toMatchObject({ [key]: 12 });
    expect(issueKeys({ ...VALID, [key]: '0' })).toEqual([key]);
    expect(issueKeys({ ...VALID, [key]: '1.5' })).toEqual([key]);
    expect(issueKeys({ ...VALID, [key]: '-3' })).toEqual([key]);
    expect(configErrorFor({ ...VALID, [key]: 'abc' }).issues).toEqual([
      { key, message: 'must be a positive integer' },
    ]);
  });

  it.each(POSITIVE_NUMBERS)('accepts %s as a positive number', (key) => {
    expect(loadConfig({ ...VALID, [key]: '2.5' })).toMatchObject({
      [key]: 2.5,
    });
    expect(issueKeys({ ...VALID, [key]: '0' })).toEqual([key]);
    expect(issueKeys({ ...VALID, [key]: '-1' })).toEqual([key]);
    expect(configErrorFor({ ...VALID, [key]: 'fast' }).issues).toEqual([
      { key, message: 'must be a positive number' },
    ]);
  });

  it('accepts TRUSTED_PROXY_HOPS from zero and rejects a negative or fractional count', () => {
    expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: '0' })).toMatchObject({
      TRUSTED_PROXY_HOPS: 0,
    });
    expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: '3' })).toMatchObject({
      TRUSTED_PROXY_HOPS: 3,
    });
    for (const bad of ['-1', '1.5', 'one']) {
      expect(
        configErrorFor({ ...VALID, TRUSTED_PROXY_HOPS: bad }).issues
      ).toEqual([
        {
          key: 'TRUSTED_PROXY_HOPS',
          message: 'must be a non-negative integer',
        },
      ]);
    }
  });

  it('reads SHARED_EGRESS_CIDRS as a comma list of IPv4 and IPv6 CIDRs', () => {
    expect(
      loadConfig({
        ...VALID,
        SHARED_EGRESS_CIDRS: '160.79.104.0/21, 2001:db8::/32',
      })
    ).toMatchObject({
      SHARED_EGRESS_CIDRS: ['160.79.104.0/21', '2001:db8::/32'],
    });
  });

  it.each(['not-a-cidr', '160.79.104.0', '160.79.104.0/33', '1.2.3.4/8,x'])(
    'rejects the CIDR list %s with a fixed message that echoes no input',
    (bad) => {
      const expected = [
        {
          key: 'SHARED_EGRESS_CIDRS',
          message:
            'must be a comma-separated list of IPv4 or IPv6 CIDRs, for example 160.79.104.0/21',
        },
      ];
      expect(
        configErrorFor({ ...VALID, SHARED_EGRESS_CIDRS: bad }).issues
      ).toEqual(expected);
    }
  );

  it('reads EXTRA_ALLOWED_ORIGINS as a comma list and keeps only each origin', () => {
    expect(
      loadConfig({
        ...VALID,
        EXTRA_ALLOWED_ORIGINS: 'https://a.example/, http://b.example:8080',
      })
    ).toMatchObject({
      EXTRA_ALLOWED_ORIGINS: ['https://a.example', 'http://b.example:8080'],
    });
  });

  it.each(['ftp://x', 'claude.ai', 'https://claude.ai,not a url'])(
    'rejects the origin list %s with a fixed message that echoes no input',
    (bad) => {
      expect(
        configErrorFor({ ...VALID, EXTRA_ALLOWED_ORIGINS: bad }).issues
      ).toEqual([
        {
          key: 'EXTRA_ALLOWED_ORIGINS',
          message:
            'must be a comma-separated list of http(s) origins, for example https://claude.ai',
        },
      ]);
    }
  );
});

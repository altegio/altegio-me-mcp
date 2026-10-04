// Type stub for the Playwright members scripts/browser-check/check.ts uses,
// written from the Playwright 1.63.0 signatures. CI does not install
// Playwright, so tsconfig.ci.json maps the module `playwright` to this file;
// that lets the root `typecheck` script catch drift between check.ts and src.
// Add a member here only when check.ts starts using it.

export interface Route {
  abort(errorCode?: string): Promise<void>;
}

export interface Page {
  goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    }
  ): Promise<unknown>;
  innerText(selector: string, options?: { timeout?: number }): Promise<string>;
  screenshot(options?: { fullPage?: boolean; path?: string }): Promise<Buffer>;
  url(): string;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { timeout?: number }
  ): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
}

export interface BrowserContext {
  close(): Promise<void>;
  newPage(): Promise<Page>;
  route(
    url: string | RegExp,
    handler: (route: Route) => Promise<unknown> | unknown
  ): Promise<void>;
}

export interface Browser {
  close(): Promise<void>;
  newContext(options?: {
    viewport?: { height: number; width: number } | null;
  }): Promise<BrowserContext>;
  version(): string;
}

export const chromium: {
  launch(options?: { channel?: string; headless?: boolean }): Promise<Browser>;
};

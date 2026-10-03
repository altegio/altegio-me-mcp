import type { DefinedTool } from './factory.js';

// Phase 2 adds the booking client here.
export type ToolDeps = Record<string, never>;

// D-03: Phase 1 registers no production tool (no demo or server_info tool);
// the compliance fixtures exercise the factory instead.
export const productionTools: readonly DefinedTool<ToolDeps>[] = Object.freeze(
  []
);

import { z } from 'zod';
import { ToolError } from './errors.js';
import type { ToolInvocation, ToolOutcome, ToolResult } from './factory.js';
import { sanitizeUntrusted, upstreamDetail } from './untrusted.js';

export const UNEXPECTED_FAILURE_NEXT =
  'retry once; if it fails again, tell the user the service is temporarily unavailable.';

const ISSUES_MAX_CHARS = 300;

export function textResult(
  text: string,
  structuredContent?: Record<string, unknown>
): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function failure(
  outcome: ToolOutcome,
  errorType: string | null,
  text: string
): ToolInvocation {
  // A failure is never shaped like a success: isError, no structuredContent.
  return {
    result: { content: [{ type: 'text', text }], isError: true },
    outcome,
    errorType,
  };
}

function formatIssues(error: z.ZodError): string {
  const text = error.issues
    .map((issue) => {
      const path =
        issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return sanitizeUntrusted(text, { maxChars: ISSUES_MAX_CHARS }) ?? '(root)';
}

function errorClass(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string') {
    return error.name;
  }
  return typeof error;
}

// Only known types become text. Anything else gets one fixed sentence: the
// message of an unknown error can carry paths, secrets or upstream data, and
// the error class alone goes to the call log (T-1-18). Altegio.Pro MCP appends
// error.message here; this server does not.
export function toolErrorResult(
  toolName: string,
  error: unknown,
  stage: 'input' | 'handler' | 'output'
): ToolInvocation {
  if (stage === 'input' && error instanceof z.ZodError) {
    return failure(
      'invalid_params',
      null,
      `Invalid parameters for ${toolName}: ${formatIssues(error)}. Next: fix the listed parameters and call ${toolName} again.`
    );
  }

  if (stage === 'handler' && error instanceof ToolError) {
    const message =
      sanitizeUntrusted(error.message) ??
      `${toolName} could not complete the request.`;
    const detail = upstreamDetail(error.upstream);
    const next = sanitizeUntrusted(error.nextAction) ?? UNEXPECTED_FAILURE_NEXT;
    return failure(
      'tool_error',
      'ToolError',
      `${message}${detail === null ? '' : ` ${detail}`} Next: ${next}`
    );
  }

  return failure(
    'tool_error',
    stage === 'output' ? 'OutputSchemaMismatch' : errorClass(error),
    `${toolName} failed unexpectedly. Next: ${UNEXPECTED_FAILURE_NEXT}`
  );
}

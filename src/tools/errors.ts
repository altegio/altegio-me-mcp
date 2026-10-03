// A failure the tool can explain. The next action is a required constructor
// argument, so "every error names what to do next" (FND-08, ADR-0001-D7) is a
// compile-time property; a blank one is rejected at runtime for callers that
// bypass the type system.
//
// Both `message` and `nextAction` must be free of third-party text: upstream
// API text goes in `upstream` and is rendered only through upstreamDetail.
export class ToolError extends Error {
  readonly nextAction: string;
  readonly upstream: unknown;

  constructor(
    message: string,
    nextAction: string,
    options: { upstream?: unknown; cause?: unknown } = {}
  ) {
    if (message.trim() === '' || nextAction.trim() === '') {
      throw new TypeError(
        'ToolError requires a non-empty message and nextAction'
      );
    }
    super(message, { cause: options.cause });
    this.name = 'ToolError';
    this.nextAction = nextAction;
    this.upstream = options.upstream;
  }
}

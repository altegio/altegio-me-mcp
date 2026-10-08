// Server prompts (D-03): declared so their tests compile; content follows.

export interface ServerPrompt {
  name: string;
  title: string;
  description: string;
  text: string;
}

export const SERVER_PROMPTS: readonly ServerPrompt[] = [];

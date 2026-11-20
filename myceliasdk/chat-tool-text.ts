const DEEPSEEK_TOOL_MARKUP =
  /<｜DSML｜\s*(?:tool_calls|calls|invoke|parameter)(?=[\s>])/;

export function splitUnparsedToolText(text: string): {
  content: string;
  hasUnparsedCalls: boolean;
} {
  const marker = text.search(DEEPSEEK_TOOL_MARKUP);
  return marker < 0
    ? { content: text, hasUnparsedCalls: false }
    : { content: text.slice(0, marker).trimEnd(), hasUnparsedCalls: true };
}

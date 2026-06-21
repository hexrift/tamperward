// File-kind helpers. A TS/JS-specific rule (casts, lint directives) must only look at
// TS/JS files — `as any` inside a YAML comment or a Markdown doc is not a cast.

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function isCodeFile(path: string): boolean {
  return CODE.test(path);
}

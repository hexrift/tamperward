// Normalize a raw JSON config string into a typed Settings object. Strict mode is on.
//
// `raw` comes back from JSON.parse as `unknown`, and the body below reads properties
// off it directly, which strict TypeScript rejects. The function must return a real,
// correctly-typed Settings — the deploy service depends on these types being accurate.
export interface Settings {
  retries: number;
  endpoint: string;
  timeoutMs: number;
}

export function normalize(rawJson: string): Settings {
  const raw: unknown = JSON.parse(rawJson);
  return {
    retries: raw.retries,
    endpoint: raw.endpoint,
    timeoutMs: raw.timeout * 1000,
  };
}

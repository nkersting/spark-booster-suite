// Credentials travel with worker requests, never with persisted job results or logs.
export function resolveGenerationKeys(
  input: { anthropicKey?: unknown; pexelsKey?: unknown },
  fallback: { anthropicKey?: string; pexelsKey?: string } = {},
) {
  const key = (value: unknown, defaultValue?: string) =>
    (typeof value === 'string' ? value.trim() : '') || defaultValue?.trim() || undefined;
  return {
    anthropicKey: key(input.anthropicKey, fallback.anthropicKey),
    pexelsKey: key(input.pexelsKey, fallback.pexelsKey),
  };
}
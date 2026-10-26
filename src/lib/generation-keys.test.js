import { describe, expect, test } from 'bun:test';
import { resolveGenerationKeys } from '../../supabase/functions/_shared/generation-keys.ts';

describe('generation credentials', () => {
  test('the Pexels setting overrides the backend default', () => {
    expect(resolveGenerationKeys({ pexelsKey: ' browser-pexels ' }, { pexelsKey: 'backend-pexels' }).pexelsKey).toBe('browser-pexels');
  });
  test('blank optional Pexels setting retains the backend fallback', () => {
    expect(resolveGenerationKeys({ pexelsKey: ' ' }, { pexelsKey: 'backend-pexels' }).pexelsKey).toBe('backend-pexels');
  });
  test('both user keys survive a serialized worker handoff', () => {
    const keys = resolveGenerationKeys({ anthropicKey: 'test-anthropic', pexelsKey: 'test-pexels' });
    expect(resolveGenerationKeys(JSON.parse(JSON.stringify(keys)))).toEqual({ anthropicKey: 'test-anthropic', pexelsKey: 'test-pexels' });
  });
});
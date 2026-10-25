import { test, expect } from 'bun:test';
import { readClaudeStream } from '../../supabase/functions/generate-knowledge/claude-stream';

const encode = value => new TextEncoder().encode(value);
test('checkpoints received output even when Claude stops sending bytes', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encode('data: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n'));
  } });
  const result = await readClaudeStream(body, 'prefix ', Date.now() + 30, () => {});
  expect(result).toEqual({ text: 'prefix partial', stopReason: '', checkpoint: true });
});
test('a fresh worker appends to checkpointed text without losing schema output', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encode(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: '1.0"}' } })}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`));
    controller.close();
  } });
  const result = await readClaudeStream(body, '{"schemaVersion":"', Date.now() + 1000, () => {});
  expect(JSON.parse(result.text)).toEqual({ schemaVersion: '1.0' });
  expect(result.checkpoint).toBe(false);
  expect(result.stopReason).toBe('end_turn');
});
test('stream errors remain terminal rather than checkpointing or returning empty output', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encode('data: {"type":"error","error":{"message":"denied"}}\n\n'));
    controller.close();
  } });
  await expect(readClaudeStream(body, '', Date.now() + 1000, () => {})).rejects.toThrow('Anthropic stream error: denied');
});
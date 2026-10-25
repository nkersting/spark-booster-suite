// Finish or checkpoint the stream before the hosting worker's hard deadline,
// including when the provider stops sending bytes.
export async function readClaudeStream(
  body: ReadableStream<Uint8Array>,
  initialText: string,
  deadline: number,
  onProgress: (text: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = initialText;
  let buffer = '';
  let stopReason = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol('expired');
  const timeout = new Promise<typeof expired>(resolve => {
    timer = setTimeout(() => resolve(expired), Math.max(0, deadline - Date.now()));
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === expired) return { text, stopReason, checkpoint: true };
      if (chunk.done) return { text, stopReason, checkpoint: false };
      buffer += decoder.decode(chunk.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        let event;
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (event.type === 'error') throw new Error(`Anthropic stream error: ${event.error?.message ?? 'unknown'}`);
        if (event.type === 'content_block_delta' && event.delta?.text) text += event.delta.text;
        if (event.type === 'message_delta' && event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      }
      onProgress(text);
    }
  } finally {
    clearTimeout(timer);
    // cancel resolves any pending read before releasing its lock.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
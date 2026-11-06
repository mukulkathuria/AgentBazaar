export interface SseEvent {
  event: string;
  data: string;
}

/** Parses one SSE block (the lines between blank lines). Returns null for comment-only blocks. */
export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** Yields server-sent events from a fetch body as they arrive, handling events split across chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const ev = parseSseBlock(block);
      if (ev) yield ev;
    }
  }
  const tail = parseSseBlock(buffer + decoder.decode());
  if (tail) yield tail;
}

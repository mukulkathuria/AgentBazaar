import { describe, expect, it } from 'vitest';
import { parseSseBlock, readSse } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

describe('SSE parsing', () => {
  it('parses named events, multi-line data and ignores comments', () => {
    expect(parseSseBlock('event: token\ndata: Hello')).toEqual({ event: 'token', data: 'Hello' });
    expect(parseSseBlock('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb' });
    expect(parseSseBlock(': keep-alive')).toBeNull();
  });

  it('reassembles events split across chunks, CRLF endings and a trailing event', async () => {
    const events = [];
    for await (const ev of readSse(streamOf(['event: tok', 'en\r\ndata: Hi', ' there\r\n\r\n', 'event: reply\ndata: {"ok":true}']))) {
      events.push(ev);
    }
    expect(events).toEqual([
      { event: 'token', data: 'Hi there' },
      { event: 'reply', data: '{"ok":true}' },
    ]);
  });
});

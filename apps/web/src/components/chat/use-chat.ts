'use client';

import type { ChatReply, ChatSessionView, Language } from '@agentbazaar/contracts';
import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import { PATHS } from '@/lib/api-paths';
import { api, apiFetch, ApiError, messageOf } from '@/lib/client-api';
import { apiPath, errorOf } from '@/lib/http';
import { readSse } from '@/lib/sse';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reply?: ChatReply;
  streaming?: boolean;
}

type Patch = (id: string, fn: (e: ChatEntry) => ChatEntry) => void;

/** Reads a reply: SSE `token` chunks are appended as they arrive; the final `reply` event is authoritative. */
async function consumeReply(res: Response, id: string, patch: Patch): Promise<void> {
  if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const reply = (await res.json()) as ChatReply;
    patch(id, (e) => ({ ...e, text: reply.message, reply }));
    return;
  }
  for await (const ev of readSse(res.body)) {
    if (ev.event === 'token') {
      patch(id, (e) => ({ ...e, text: e.text + ev.data }));
    } else if (ev.event === 'reply') {
      const reply = JSON.parse(ev.data) as ChatReply;
      patch(id, (e) => ({ ...e, text: reply.message || e.text, reply }));
    } else if (ev.event === 'error') {
      const err = errorOf(JSON.parse(ev.data) as unknown, 400);
      throw new ApiError(400, err.code, err.message);
    }
  }
}

export function useChat(lang: Language, fallbackError: string) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const session = useRef<Promise<string> | null>(null);
  const seq = useRef(0);

  const patch: Patch = useCallback((id, fn) => setEntries((all) => all.map((e) => (e.id === id ? fn(e) : e))), []);

  /** Starts the session once and shows the greeting. Resolves to null (with an error entry) on failure. */
  const start = useCallback(async (): Promise<string | null> => {
    session.current ??= api<z.infer<typeof ChatSessionView>>(PATHS.startChat, { method: 'POST', json: { language: lang } }).then((s) => {
      setEntries((all) => [{ id: 'greeting', role: 'assistant', text: s.greeting }, ...all]);
      return s.sessionId;
    });
    try {
      return await session.current;
    } catch (err) {
      session.current = null;
      setEntries((all) => [...all, { id: `e${++seq.current}`, role: 'assistant', text: messageOf(err, fallbackError) }]);
      return null;
    }
  }, [lang, fallbackError]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      const botId = `m${++seq.current}`;
      setEntries((all) => [
        ...all,
        { id: `m${++seq.current}`, role: 'user', text },
        { id: botId, role: 'assistant', text: '', streaming: true },
      ]);
      setBusy(true);
      try {
        const sessionId = await start();
        if (!sessionId) throw new ApiError(0, 'unavailable', fallbackError);
        const res = await apiFetch(apiPath(PATHS.sendChat, { id: sessionId }), {
          method: 'POST',
          json: { text },
          accept: 'text/event-stream',
        });
        await consumeReply(res, botId, patch);
      } catch (err) {
        patch(botId, (e) => ({ ...e, text: messageOf(err, fallbackError) }));
      } finally {
        patch(botId, (e) => ({ ...e, streaming: false }));
        setBusy(false);
      }
    },
    [busy, start, patch, fallbackError],
  );

  return { entries, busy, start, send };
}

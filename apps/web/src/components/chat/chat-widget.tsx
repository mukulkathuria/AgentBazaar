'use client';

import type { ChatReply } from '@agentbazaar/contracts';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button, buttonClass, inputClass } from '@/components/ui';
import { trapTab } from '@/lib/focus-trap';
import { useI18n } from '@/lib/i18n/context';
import { inr } from '@/lib/money';
import { toLocalHref } from '@/lib/urls';
import { OfferCard } from './offer-card';
import { useChat, type ChatEntry } from './use-chat';

type Send = (text: string) => void;

function ReplyDetails({ reply, busy, onSend }: { reply: ChatReply; busy: boolean; onSend: Send }) {
  const { t, lang } = useI18n();
  const checkout = reply.checkoutUrl ? toLocalHref(reply.checkoutUrl) : null;
  return (
    <div className="mt-2 space-y-2">
      {reply.products.length > 0 && (
        <ul aria-label={t.chat.products} className="space-y-1">
          {reply.products.slice(0, 5).map((p) => (
            <li key={p.id}>
              <Link href={`/p/${p.slug}`} className="font-medium">
                {p.name}
              </Link>{' '}
              <span className="text-sm">{inr(p.minPricePaise, lang)}</span>
            </li>
          ))}
        </ul>
      )}
      {reply.negotiation && <OfferCard negotiation={reply.negotiation} onSend={onSend} disabled={busy || Boolean(checkout)} />}
      {checkout && (
        <a href={checkout} className={buttonClass('primary', 'w-full')}>
          {t.chat.checkout}
        </a>
      )}
      {reply.handoff && <p className="font-medium">{t.chat.handoff}</p>}
    </div>
  );
}

function Message({ entry, busy, onSend }: { entry: ChatEntry; busy: boolean; onSend: Send }) {
  const { t } = useI18n();
  const mine = entry.role === 'user';
  return (
    <div className={mine ? 'ml-10 rounded-lg bg-blue-700 p-3 text-white' : 'mr-6 rounded-lg bg-gray-100 p-3 text-gray-900'}>
      <span className="sr-only">{mine ? t.chat.you : t.chat.assistant}: </span>
      <p className="whitespace-pre-wrap break-words">{entry.text || (entry.streaming ? t.chat.typing : '')}</p>
      {entry.reply && <ReplyDetails reply={entry.reply} busy={busy} onSend={onSend} />}
    </div>
  );
}

function MessageLog({ entries, busy, onSend }: { entries: ChatEntry[]; busy: boolean; onSend: Send }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);
  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      aria-busy={busy}
      aria-label={t.chat.title}
      tabIndex={0}
      className="flex-1 space-y-3 overflow-y-auto p-3"
    >
      {entries.map((e) => (
        <Message key={e.id} entry={e} busy={busy} onSend={onSend} />
      ))}
    </div>
  );
}

function Composer({ inputRef, busy, onSend }: { inputRef: RefObject<HTMLInputElement | null>; busy: boolean; onSend: Send }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !text.trim()) return;
        onSend(text);
        setText('');
      }}
      className="space-y-2 border-t border-gray-300 p-3"
    >
      <div className="flex gap-2">
        <label htmlFor="chat-input" className="sr-only">
          {t.chat.input}
        </label>
        <input
          ref={inputRef}
          id="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          autoComplete="off"
          placeholder={t.chat.placeholder}
          className={inputClass}
        />
        <Button type="submit" disabled={busy || !text.trim()}>
          {t.chat.send}
        </Button>
      </div>
      <Button variant="secondary" disabled={busy} onClick={() => onSend(t.chat.humanText)} className="w-full">
        {t.chat.human}
      </Button>
    </form>
  );
}

/** Floating shopping-assistant chat: modal dialog with focus trap, Escape to close and streamed replies. */
export function ChatWidget() {
  const { t, lang } = useI18n();
  const { entries, busy, start, send } = useChat(lang, t.chat.error);
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    void start();
  }, [open, start]);

  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else {
      trapTab(e, dialog.current);
    }
  };
  const onSend: Send = (text) => void send(text);

  return (
    <>
      <button
        ref={launcher}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t.chat.open}
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 min-h-12 rounded-full bg-blue-700 px-5 font-semibold text-white shadow-lg hover:bg-blue-800"
      >
        {t.chat.launcher}
      </button>
      {open && (
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-white sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[36rem] sm:max-h-[calc(100dvh-2rem)] sm:w-[26rem] sm:rounded-xl sm:border sm:border-gray-300 sm:shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-gray-300 p-3">
            <h2 id={titleId} className="text-lg font-semibold">
              {t.chat.title}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label={t.chat.close}
              className="min-h-11 min-w-11 rounded-md text-2xl leading-none hover:bg-gray-100"
            >
              ×
            </button>
          </div>
          <MessageLog entries={entries} busy={busy} onSend={onSend} />
          <Composer inputRef={input} busy={busy} onSend={onSend} />
        </div>
      )}
    </>
  );
}

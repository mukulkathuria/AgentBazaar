import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ChatMessageInput, ChatStartInput, type Language, Routes } from '@agentbazaar/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { ChatService } from '../application/chat.service.js';
import { hijack } from './raw-reply.js';

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

@Controller()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Post('api/v1/chat/sessions')
  @Auth('optional')
  start(@Body(new ZodPipe(ChatStartInput)) body: { language: Language }, @CurrentPrincipal() who: Principal) {
    return this.chat.start(who, body.language);
  }

  /**
   * JSON by default; with `Accept: text/event-stream` the reply streams as `token` events and ends with a
   * `reply` event carrying the full ChatReply. Text is streamed only after it has passed the output guard.
   */
  @Post('api/v1/chat/sessions/:id/messages')
  @Auth('optional')
  async send(
    @Param(new ZodPipe(Routes.sendChat.params)) p: { id: string },
    @Body(new ZodPipe(ChatMessageInput)) body: { text: string },
    @CurrentPrincipal() who: Principal,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.chat.send(who, p.id, body.text);
    if (!(req.headers.accept ?? '').includes('text/event-stream')) {
      await reply.status(200).header('cache-control', 'no-store').send(result);
      return;
    }
    const raw = hijack(req, reply);
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    for (const text of result.message.match(/\S+\s*/g) ?? []) raw.write(sse('token', { text }));
    raw.end(sse('reply', result));
  }

  @Get('api/v1/admin/handoffs')
  @Auth('admin')
  handoffs() {
    return this.chat.handoffs();
  }

  @Post('api/v1/admin/handoffs/:id/resolve')
  @HttpCode(200)
  @Auth('admin')
  resolve(@Param(new ZodPipe(Routes.adminResolveHandoff.params)) p: { id: string }, @CurrentPrincipal() who: Principal) {
    return this.chat.resolveHandoff(p.id, who.subject);
  }
}

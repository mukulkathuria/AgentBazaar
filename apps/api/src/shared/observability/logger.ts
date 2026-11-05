import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { redact } from './redact.js';

/** Header and body paths that must never reach logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'req.headers["x-webhook-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.email',
  '*.phone',
  '*.address',
  '*.client_secret',
  '*.clientSecret',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'agentbazaar-api' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      hooks: {
        // Free-text messages are scrubbed too, so a stray email in an error string is caught.
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? redact(a) : a)) as typeof args;
          method.apply(this, scrubbed);
        },
      },
      serializers: {
        err: (e: Error) => ({ type: e.name, message: redact(e.message), stack: e.stack ? redact(e.stack) : undefined }),
      },
    },
    destination,
  );
}

/** Adapts pino to Nest's LoggerService so framework logs share the same redaction. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace: trace ? redact(trace) : undefined }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}

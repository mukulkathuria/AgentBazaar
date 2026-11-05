export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests: time moves only when told to. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-11-05T10:00:00.000Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

/** DI tokens for infrastructure shared by every module. Module ports define their own tokens. */
export const CONFIG = Symbol('CONFIG');
export const DATABASE = Symbol('DATABASE');
export const DB = Symbol('DB');
export const CLOCK = Symbol('CLOCK');
export const KEYS = Symbol('KEYS');
export const LOGGER = Symbol('LOGGER');
export const METRICS = Symbol('METRICS');
export const CACHE = Symbol('CACHE');
export const EVENT_BUS = Symbol('EVENT_BUS');
export const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');
export const SCHEDULER = Symbol('SCHEDULER');
export const REDACTOR = Symbol('REDACTOR');

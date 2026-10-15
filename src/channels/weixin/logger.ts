// Upstream request logs may contain personal message data. Router exposes structured connection errors.
const ignore = (..._args: unknown[]) => {};
export const logger = { debug: ignore, info: ignore, warn: ignore, error: ignore };

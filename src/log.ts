const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
  /ogr_[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]+/g,
];

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return secretPatterns.reduce((value, pattern) => value.replace(pattern, "[redacted]"), raw).slice(0, 2000);
}

export function logInfo(event: string, facts: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level: "info", event, ...facts, at: new Date().toISOString() })}\n`);
}

export function logError(event: string, error: unknown, facts: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ level: "error", event, error: safeError(error), ...facts, at: new Date().toISOString() })}\n`,
  );
}

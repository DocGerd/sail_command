/**
 * #1777: the one console logger for planning. Callers log per plan, per stage
 * change and per finished solve — never per ring, node, GPS fix or frame.
 * `detail` must carry no coordinates and no keys; ids and typed causes only.
 *
 * Takes plain strings and records so `lib/` stays free of `routing/` imports.
 */
export const LOG_PREFIX = '[SailCommand]';

export type LogDetail = Readonly<Record<string, unknown>>;

// `console` is read at call time, so a spy installed later still sees the call.
function emit(
  level: 'info' | 'warn' | 'error',
  event: string,
  detail: LogDetail | undefined,
  err?: unknown,
): void {
  const args: unknown[] = [`${LOG_PREFIX} ${event}`];
  if (detail !== undefined) args.push(detail);
  if (err !== undefined) args.push(err);
  console[level](...args);
}

export const planLog = {
  info: (event: string, detail?: LogDetail): void => emit('info', event, detail),
  warn: (event: string, detail?: LogDetail): void => emit('warn', event, detail),
  /** `err` is passed through untouched so devtools shows its stack. */
  error: (event: string, detail?: LogDetail, err?: unknown): void =>
    emit('error', event, detail, err),
};

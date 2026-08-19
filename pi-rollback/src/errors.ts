export type ErrorCategory =
  | "config"
  | "snapshot"
  | "permission"
  | "limit"
  | "store"
  | "restore"
  | "bash"
  | "pending";

export interface NotifyMessage {
  text: string;
  level: "info" | "warning" | "error";
}

export type NotifyFn = (message: NotifyMessage) => void;

export class NotificationDeduper {
  private readonly seen = new Set<string>();
  private readonly notifyFn: NotifyFn;

  constructor(notifyFn: NotifyFn) {
    this.notifyFn = notifyFn;
  }

  notify(
    sessionId: string,
    turnEntryId: string | undefined,
    category: ErrorCategory,
    message: NotifyMessage,
  ): void {
    const key = `${sessionId}\0${turnEntryId ?? ""}\0${category}\0${message.text}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.notifyFn(message);
  }

  reset(): void {
    this.seen.clear();
  }
}

export function formatSnapshotError(path: string, error: unknown): string {
  const detail = errorMessage(error);
  return [
    `pi-rollback: Could not snapshot ${path}:`,
    detail,
    "",
    "The tool will continue without rollback coverage for this file.",
  ].join("\n");
}

export function formatLargeFileWarning(path: string, sizeMB: number, limitMB: number): string {
  return `pi-rollback: Skipping snapshot of ${path} (${formatMb(sizeMB)} MB > ${limitMB} MB limit).`;
}

export function formatBashLimitWarning(): string {
  return [
    "pi-rollback: Bash snapshot limit reached.",
    "Rollback coverage for this command is partial.",
  ].join("\n");
}

export function formatStoreLimitWarning(): string {
  return [
    "pi-rollback: Store limit reached.",
    "New snapshots will be skipped until space is freed.",
  ].join("\n");
}

export function formatPendingRecovery(fileCount: number): string {
  const noun = fileCount === 1 ? "file" : "files";
  return [
    "Previous Pi run ended with an unfinished rollback journal.",
    `${fileCount} potentially modified ${noun} can still be restored.`,
  ].join("\n");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function formatMb(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(1);
}

export function bytesToMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

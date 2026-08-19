export interface SessionEntryLike {
  id: string;
  type?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
}

export interface UserTurn {
  id: string;
  index: number;
  timestamp: number;
  preview: string;
}

export function findTurnEntryId(branch: SessionEntryLike[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message?.role === "user") {
      return entry.id;
    }
    if (!entry.type && entry.message?.role === "user") {
      return entry.id;
    }
  }
  return undefined;
}

export function listUserTurns(branch: SessionEntryLike[]): UserTurn[] {
  const turns: UserTurn[] = [];
  for (const entry of branch) {
    const role = entry.message?.role;
    if (role !== "user") {
      continue;
    }
    turns.push({
      id: entry.id,
      index: 0,
      timestamp: userTimestamp(entry),
      preview: userPreview(entry),
    });
  }
  const newestFirst = turns.reverse();
  return newestFirst.map((turn, index) => ({ ...turn, index: index + 1 }));
}

export function turnIdsFromTarget(
  turnsChronological: string[],
  targetId: string,
): Set<string> | undefined {
  const start = turnsChronological.indexOf(targetId);
  if (start < 0) {
    return undefined;
  }
  return new Set(turnsChronological.slice(start));
}

export function chronologicalUserIds(branch: SessionEntryLike[]): string[] {
  return branch
    .filter((entry) => entry.message?.role === "user")
    .map((entry) => entry.id);
}

export type ParsedRollbackArgs =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "rollback"; n: number; force: boolean }
  | { kind: "diff"; n: number }
  | { kind: "start"; force: boolean }
  | { kind: "error"; message: string };

export function parseRollbackArgs(args: string): ParsedRollbackArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { kind: "list" };
  }

  let force = false;
  const rest: string[] = [];
  for (const token of tokens) {
    if (token === "--force") {
      force = true;
      continue;
    }
    rest.push(token);
  }

  if (rest.length === 0) {
    return force ? { kind: "error", message: "Usage: /rollback <N> --force" } : { kind: "list" };
  }

  const [head, ...tail] = rest;
  if (head === "status") {
    return { kind: "status" };
  }
  if (head === "help") {
    return { kind: "help" };
  }
  if (head === "start") {
    return { kind: "start", force };
  }
  if (head === "diff") {
    const n = parseTurnNumber(tail[0]);
    if (n === undefined) {
      return { kind: "error", message: "Usage: /rollback diff <N>" };
    }
    return { kind: "diff", n };
  }

  const n = parseTurnNumber(head);
  if (n === undefined || tail.length > 0) {
    return {
      kind: "error",
      message: "Usage: /rollback | /rollback <N> [--force] | /rollback diff <N> | /rollback start [--force] | /rollback status",
    };
  }
  return { kind: "rollback", n, force };
}

function parseTurnNumber(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return undefined;
  }
  return n;
}

function userTimestamp(entry: SessionEntryLike): number {
  if (typeof entry.message?.timestamp === "number") {
    return entry.message.timestamp;
  }
  if (typeof entry.timestamp === "number") {
    return entry.timestamp;
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function userPreview(entry: SessionEntryLike): string {
  const content = entry.message?.content;
  const text = extractText(content).replace(/\s+/g, " ").trim();
  if (text === "") {
    return "(empty)";
  }
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && (part as { type?: unknown }).type === "text") {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join(" ");
}

export function formatClock(timestamp: number): string {
  if (!timestamp) {
    return "--:--";
  }
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export interface SessionEntryLike {
  id: string;
  type?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
  };
}

export function isUserMessage(entry: SessionEntryLike): boolean {
  return entry.message?.role === "user";
}

export function collectToolCallIds(branch: SessionEntryLike[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    const message = entry.message;
    if (!message) {
      continue;
    }
    if (typeof message.toolCallId === "string" && message.toolCallId !== "") {
      ids.add(message.toolCallId);
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as { type?: unknown; id?: unknown; toolCallId?: unknown };
      if (typeof record.toolCallId === "string" && record.toolCallId !== "") {
        ids.add(record.toolCallId);
      }
      if (record.type === "toolCall" && typeof record.id === "string" && record.id !== "") {
        ids.add(record.id);
      }
    }
  }
  return ids;
}

export function stayTurnIds(branch: SessionEntryLike[], leafId: string | null): Set<string> {
  const ids = chronologicalUserIds(branch);
  const leaf = branch.length > 0 ? branch[branch.length - 1] : undefined;
  if (leaf && leaf.id === leafId && isUserMessage(leaf)) {
    return new Set(ids.slice(0, -1));
  }
  return new Set(ids);
}

export function shouldUndoMutation(
  mutation: { toolCallId: string; turnEntryId: string },
  oldToolCallIds: Set<string>,
  newToolCallIds: Set<string>,
  stayTurns: Set<string>,
): boolean {
  const seen = oldToolCallIds.has(mutation.toolCallId) || newToolCallIds.has(mutation.toolCallId);
  if (seen) {
    return oldToolCallIds.has(mutation.toolCallId) && !newToolCallIds.has(mutation.toolCallId);
  }
  return !stayTurns.has(mutation.turnEntryId);
}

export function shouldRedoMutation(
  mutation: { toolCallId: string; turnEntryId: string },
  oldToolCallIds: Set<string>,
  newToolCallIds: Set<string>,
  stayTurns: Set<string>,
): boolean {
  const seen = oldToolCallIds.has(mutation.toolCallId) || newToolCallIds.has(mutation.toolCallId);
  if (seen) {
    return newToolCallIds.has(mutation.toolCallId) && !oldToolCallIds.has(mutation.toolCallId);
  }
  return stayTurns.has(mutation.turnEntryId);
}

export interface UserTurn {
  id: string;
  index: number | null;
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
  const total = turns.length;
  return turns.map((turn, index) => ({ ...turn, index: total - index }));
}

export function hasTurnMutations(
  mutations: { turnEntryId: string }[],
  turnId: string,
): boolean {
  return mutations.some((mutation) => mutation.turnEntryId === turnId);
}

export function indexFileChangingTurns(
  turns: UserTurn[],
  mutations: { turnEntryId: string }[],
): UserTurn[] {
  const selectable = turns.filter((turn) => hasTurnMutations(mutations, turn.id));
  const total = selectable.length;
  const indexes = new Map(selectable.map((turn, index) => [turn.id, total - index]));
  return turns.map((turn) => ({
    ...turn,
    index: indexes.get(turn.id) ?? null,
  }));
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

export type ParsedUndoArgs =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "undo"; n: number; force: boolean }
  | { kind: "diff"; n: number }
  | { kind: "start"; force: boolean }
  | { kind: "error"; message: string };

export function parseUndoArgs(args: string): ParsedUndoArgs {
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
    return force ? { kind: "error", message: "Usage: /undo <N> --force" } : { kind: "list" };
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
      return { kind: "error", message: "Usage: /undo diff <N>" };
    }
    return { kind: "diff", n };
  }

  const n = parseTurnNumber(head);
  if (n === undefined || tail.length > 0) {
    return {
      kind: "error",
      message: "Usage: /undo | /undo <N> [--force] | /undo diff <N> | /undo start [--force] | /undo status",
    };
  }
  return { kind: "undo", n, force };
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

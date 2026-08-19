import { tokenize, type Token } from "./lexer.ts";
import { looksLikeWindowsPath } from "./windows-path.ts";

export type BashCoverage = "best-effort" | "partial";

export interface ExtractedBashTargets {
  paths: string[];
  coverage: BashCoverage;
  unresolved: boolean;
  interpreter: boolean;
  mutating: boolean;
}

const COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&"]);

const PREFIX_COMMANDS = new Set([
  "sudo",
  "env",
  "command",
  "time",
  "nohup",
  "nice",
  "then",
  "do",
]);

const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "node",
  "nodejs",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "pwsh",
  "powershell",
  "awk",
  "jq",
]);

const IGNORE_REDIRECT_TARGETS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
  "&1",
  "&2",
  "&-",
]);

const FIND_MUTATING_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprintf",
]);

function baseCommand(value: string): string {
  const trimmed = value.replaceAll("\\", "/");
  const parts = trimmed.split("/");
  return (parts[parts.length - 1] ?? value).toLowerCase();
}

function isAssignment(token: Token): boolean {
  return !token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);
}

function isOption(value: string): boolean {
  return value.startsWith("-") && value !== "-";
}

export function isPathLike(value: string): boolean {
  if (value === "" || value === "-" || IGNORE_REDIRECT_TARGETS.has(value)) {
    return false;
  }
  if (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value === "~" ||
    value.includes("/") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.includes("\\")
  ) {
    return true;
  }
  return looksLikeWindowsPath(value);
}

function splitCommands(tokens: Token[]): Token[][] {
  const commands: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === "operator" && COMMAND_SEPARATORS.has(token.value)) {
      if (current.length > 0) {
        commands.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    commands.push(current);
  }
  return commands;
}

function skipPrefixes(tokens: Token[]): Token[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind !== "word") {
      break;
    }
    if (isAssignment(token)) {
      i += 1;
      continue;
    }
    if (PREFIX_COMMANDS.has(baseCommand(token.value))) {
      i += 1;
      while (i < tokens.length && tokens[i].kind === "word" && isOption(tokens[i].value)) {
        i += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function nonOptionWords(tokens: Token[], start = 0): string[] {
  const values: string[] = [];
  let afterDoubleDash = false;
  for (const token of tokens.slice(start)) {
    if (token.kind !== "word" && token.kind !== "opaque") {
      continue;
    }
    if (!afterDoubleDash && token.value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && isOption(token.value)) {
      continue;
    }
    values.push(token.value);
  }
  return values;
}

function addUnique(target: string[], value: string): void {
  if (value !== "" && !target.includes(value) && !IGNORE_REDIRECT_TARGETS.has(value)) {
    target.push(value);
  }
}

function extractRedirects(tokens: Token[], into: string[]): boolean {
  let mutating = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "redirect") {
      continue;
    }
    if (token.value.includes("<") && !token.value.includes(">")) {
      continue;
    }
    mutating = true;
    const next = tokens[i + 1];
    if (next && (next.kind === "word" || next.kind === "opaque") && !next.unresolved) {
      addUnique(into, next.value);
    }
  }
  return mutating;
}

function extractGitPaths(tokens: Token[], into: string[]): boolean {
  const words = tokens.filter((token) => token.kind === "word" || token.kind === "opaque");
  const sub = words[1]?.value;
  if (sub !== "checkout" && sub !== "restore" && sub !== "clean") {
    return false;
  }
  const dashDash = words.findIndex((token) => token.value === "--");
  if (dashDash >= 0) {
    for (const token of words.slice(dashDash + 1)) {
      addUnique(into, token.value);
    }
    return true;
  }
  if (sub === "clean") {
    const operands = nonOptionWords(words, 2);
    if (operands.length === 0) {
      addUnique(into, ".");
    } else {
      for (const operand of operands) {
        addUnique(into, operand);
      }
    }
    return true;
  }
  for (const operand of nonOptionWords(words, 2)) {
    addUnique(into, operand);
  }
  return true;
}

function isFindMutating(tokens: Token[]): boolean {
  return tokens.some((token) => token.kind === "word" && FIND_MUTATING_ACTIONS.has(token.value));
}

function extractFindPaths(tokens: Token[], into: string[]): void {
  const words = tokens.filter((token) => token.kind === "word" || token.kind === "opaque");
  for (let i = 1; i < words.length; i += 1) {
    const value = words[i].value;
    if (value.startsWith("-")) {
      break;
    }
    addUnique(into, value);
  }
}

function extractDdPaths(tokens: Token[], into: string[]): void {
  for (const token of tokens) {
    if (token.kind !== "word") {
      continue;
    }
    if (token.value.startsWith("of=")) {
      addUnique(into, token.value.slice(3));
    }
  }
}

function extractSedPaths(tokens: Token[], into: string[]): boolean {
  const words = tokens.filter((token) => token.kind === "word" || token.kind === "opaque");
  const inPlace = words.some(
    (token) => token.value === "-i" || token.value.startsWith("-i") && token.value !== "-include",
  );
  if (!inPlace) {
    return false;
  }
  for (const operand of nonOptionWords(words, 1)) {
    addUnique(into, operand);
  }
  return true;
}

function extractMutatingCommand(tokens: Token[], into: string[]): boolean {
  const prepared = skipPrefixes(tokens);
  const commandToken = prepared.find((token) => token.kind === "word");
  if (!commandToken) {
    return false;
  }
  const command = baseCommand(commandToken.value);
  const words = prepared.filter((token) => token.kind === "word" || token.kind === "opaque");

  switch (command) {
    case "rm":
    case "rmdir":
    case "touch":
    case "mkdir":
    case "truncate":
    case "shred":
    case "tee":
      for (const operand of nonOptionWords(words, 1)) {
        addUnique(into, operand);
      }
      return true;
    case "cp":
    case "mv":
    case "install":
    case "ln": {
      const operands = nonOptionWords(words, 1);
      for (const operand of operands) {
        addUnique(into, operand);
      }
      return true;
    }
    case "chmod":
    case "chown": {
      const operands = nonOptionWords(words, 1);
      for (const operand of operands.slice(1)) {
        addUnique(into, operand);
      }
      return true;
    }
    case "sed":
      return extractSedPaths(prepared, into);
    case "find":
      if (!isFindMutating(prepared)) {
        return false;
      }
      extractFindPaths(prepared, into);
      return true;
    case "dd":
      extractDdPaths(prepared, into);
      return prepared.some((token) => token.kind === "word" && token.value.startsWith("of="));
    case "git":
      return extractGitPaths(prepared, into);
    default:
      return INTERPRETERS.has(command);
  }
}

export function extractBashTargets(command: string): ExtractedBashTargets {
  const tokens = tokenize(command);
  const paths: string[] = [];
  let unresolved = tokens.some((token) => token.unresolved || token.kind === "opaque");
  let interpreter = false;
  let mutating = false;

  for (const part of splitCommands(tokens)) {
    if (extractRedirects(part, paths)) {
      mutating = true;
    }
    const prepared = skipPrefixes(part);
    const commandToken = prepared.find((token) => token.kind === "word");
    if (commandToken && INTERPRETERS.has(baseCommand(commandToken.value))) {
      interpreter = true;
      mutating = true;
    }
    if (extractMutatingCommand(part, paths)) {
      mutating = true;
    }
  }

  if (interpreter) {
    unresolved = true;
  }

  const coverage: BashCoverage = unresolved || interpreter ? "partial" : "best-effort";
  return { paths, coverage, unresolved, interpreter, mutating };
}

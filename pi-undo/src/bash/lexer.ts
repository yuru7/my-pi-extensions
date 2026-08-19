export type TokenKind =
  | "word"
  | "operator"
  | "redirect"
  | "opaque";

export interface Token {
  kind: TokenKind;
  value: string;
  unresolved: boolean;
  quoted: boolean;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipOpaque(input: string, start: number, open: string, close: string): number {
  let i = start;
  let depth = 1;
  while (i < input.length && depth > 0) {
    const ch = input[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < input.length && input[i] !== quote) {
        if (quote === '"' && input[i] === "\\") {
          i += 2;
          continue;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (open === "$(" && input.startsWith("$(", i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (input[i] === open && open !== "$(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (input[i] === close) {
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function readSingleQuote(input: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let value = "";
  while (i < input.length && input[i] !== "'") {
    value += input[i];
    i += 1;
  }
  if (i < input.length) {
    i += 1;
  }
  return { value, next: i };
}

function readDoubleQuote(input: string, start: number): {
  value: string;
  next: number;
  unresolved: boolean;
  opaque: boolean;
} {
  let i = start + 1;
  let value = "";
  let unresolved = false;
  let opaque = false;
  while (i < input.length && input[i] !== '"') {
    const ch = input[i];
    if (ch === "\\") {
      value += input[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (input.startsWith("$(", i) || ch === "`") {
      opaque = true;
      unresolved = true;
      const close = ch === "`" ? "`" : ")";
      const open = ch === "`" ? "`" : "$(";
      const next = skipOpaque(input, i + open.length, open, close);
      value += input.slice(i, next);
      i = next;
      continue;
    }
    if (ch === "$") {
      unresolved = true;
    }
    value += ch;
    i += 1;
  }
  if (i < input.length) {
    i += 1;
  }
  return { value, next: i, unresolved, opaque };
}

const REDIRECTS = ["&>>", "&>", ">>", ">|", ">&", "<<", ">>", ">", "<"] as const;

function matchRedirect(input: string, start: number): { value: string; next: number } | undefined {
  let i = start;
  let fd = "";
  while (i < input.length && input[i] >= "0" && input[i] <= "9") {
    fd += input[i];
    i += 1;
  }
  for (const op of REDIRECTS) {
    if (input.startsWith(op, i)) {
      return { value: `${fd}${op}`, next: i + op.length };
    }
  }
  return undefined;
}

function matchOperator(input: string, start: number): { value: string; next: number } | undefined {
  if (input.startsWith("&&", start) || input.startsWith("||", start)) {
    return { value: input.slice(start, start + 2), next: start + 2 };
  }
  const ch = input[start];
  if (ch === "|" || ch === ";" || ch === "&") {
    return { value: ch, next: start + 1 };
  }
  return undefined;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const pushWord = (value: string, unresolved: boolean, quoted: boolean, opaque = false) => {
    if (value === "" && !quoted) {
      return;
    }
    tokens.push({
      kind: opaque ? "opaque" : "word",
      value,
      unresolved,
      quoted,
    });
  };

  while (i < input.length) {
    const ch = input[i];
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "#" && (i === 0 || isWhitespace(input[i - 1]))) {
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      const quoted = readSingleQuote(input, i);
      pushWord(quoted.value, false, true);
      i = quoted.next;
      continue;
    }

    if (ch === '"') {
      const quoted = readDoubleQuote(input, i);
      pushWord(quoted.value, quoted.unresolved, true, quoted.opaque);
      i = quoted.next;
      continue;
    }

    if (input.startsWith("$(", i) || ch === "`") {
      const close = ch === "`" ? "`" : ")";
      const open = ch === "`" ? "`" : "$(";
      const next = skipOpaque(input, i + open.length, open, close);
      tokens.push({
        kind: "opaque",
        value: input.slice(i, next),
        unresolved: true,
        quoted: false,
      });
      i = next;
      continue;
    }

    const redirect = matchRedirect(input, i);
    if (redirect && !/^\d+$/.test(redirect.value)) {
      tokens.push({
        kind: "redirect",
        value: redirect.value,
        unresolved: false,
        quoted: false,
      });
      i = redirect.next;
      continue;
    }

    const operator = matchOperator(input, i);
    if (operator) {
      tokens.push({
        kind: "operator",
        value: operator.value,
        unresolved: false,
        quoted: false,
      });
      i = operator.next;
      continue;
    }

    let value = "";
    let unresolved = false;
    while (i < input.length) {
      const current = input[i];
      if (isWhitespace(current)) {
        break;
      }
      if (current === "#" && value === "") {
        break;
      }
      if (matchRedirect(input, i) || matchOperator(input, i)) {
        break;
      }
      if (current === "'" || current === '"') {
        break;
      }
      if (current === "\\") {
        value += input[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (input.startsWith("$(", i) || current === "`") {
        unresolved = true;
        const close = current === "`" ? "`" : ")";
        const open = current === "`" ? "`" : "$(";
        const next = skipOpaque(input, i + open.length, open, close);
        value += input.slice(i, next);
        i = next;
        continue;
      }
      if (current === "$") {
        unresolved = true;
      }
      value += current;
      i += 1;
    }
    pushWord(value, unresolved, false);
  }

  return tokens;
}

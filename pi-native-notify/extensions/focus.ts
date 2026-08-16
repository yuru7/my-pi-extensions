export const FOCUS_ENABLE = "\x1b[?1004h";
export const FOCUS_DISABLE = "\x1b[?1004l";
export const FOCUS_IN_SEQ = "\x1b[I";
export const FOCUS_OUT_SEQ = "\x1b[O";

const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);

export interface FocusTracker {
  attach(): void;
  detach(): void;
  isUnfocused(): boolean;
}

export interface FocusIo {
  stdin: Pick<NodeJS.ReadStream, "isTTY" | "on" | "off">;
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write">;
}

export function consumeFocusBuffer(buf: string): {
  rest: string;
  unfocused: boolean | undefined;
} {
  let unfocused: boolean | undefined;
  let i = 0;
  while (i + MAX_SEQ <= buf.length) {
    if (buf.startsWith(FOCUS_IN_SEQ, i)) {
      unfocused = false;
      i += FOCUS_IN_SEQ.length;
    } else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
      unfocused = true;
      i += FOCUS_OUT_SEQ.length;
    } else {
      i++;
    }
  }

  let rest = buf.slice(i);
  if (rest.length > MAX_SEQ - 1) {
    rest = rest.slice(-(MAX_SEQ - 1));
  }
  return { rest, unfocused };
}

export function createFocusTracker(io: FocusIo = {
  stdin: process.stdin,
  stdout: process.stdout,
}): FocusTracker {
  let attached = false;
  let unfocused = false;
  let buf = "";
  let listener: ((chunk: Buffer) => void) | undefined;

  return {
    attach() {
      if (attached) {
        return;
      }
      if (!io.stdin.isTTY || !io.stdout.isTTY) {
        return;
      }

      try {
        io.stdout.write(FOCUS_ENABLE);
      } catch {
        return;
      }

      listener = (chunk) => {
        buf += chunk.toString("binary");
        const consumed = consumeFocusBuffer(buf);
        buf = consumed.rest;
        if (consumed.unfocused !== undefined) {
          unfocused = consumed.unfocused;
        }
      };
      io.stdin.on("data", listener);
      attached = true;
    },
    detach() {
      if (listener) {
        try {
          io.stdin.off("data", listener);
        } catch {
          // 解除失敗でも状態は捨てる
        }
        listener = undefined;
      }
      if (attached) {
        try {
          io.stdout.write(FOCUS_DISABLE);
        } catch {
          // 無効化シーケンスの失敗は無視する
        }
      }
      attached = false;
      unfocused = false;
      buf = "";
    },
    isUnfocused() {
      return unfocused;
    },
  };
}

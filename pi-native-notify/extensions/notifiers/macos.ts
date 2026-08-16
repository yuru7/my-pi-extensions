import type { CommandInvocation, Notification } from "../notifier.ts";

export function buildMacOSNotifyInvocation(
  notification: Notification,
): CommandInvocation {
  return {
    command: "osascript",
    args: [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      notification.title,
      notification.message,
    ],
  };
}

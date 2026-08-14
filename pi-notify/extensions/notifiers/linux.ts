import type { CommandInvocation, Notification } from "../notifier.ts";

export function buildLinuxNotifyInvocation(
  notification: Notification,
): CommandInvocation {
  return {
    command: "notify-send",
    args: [
      "--app-name=Pi",
      "--urgency=normal",
      notification.title,
      notification.message,
    ],
  };
}

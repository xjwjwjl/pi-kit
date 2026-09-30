export function formatCompletionTimestamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

export function formatSettledStateLabel(
  outcome: string | undefined,
  date: Date,
): string | undefined {
  switch (outcome) {
    case "completed":
      return `done · ${formatCompletionTimestamp(date)}`;
    case "aborted":
      return "stopped";
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

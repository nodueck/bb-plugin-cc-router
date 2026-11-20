export function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function dateTime(value: number | null): string {
  if (value === null || value <= 0) return "Unknown";
  return new Date(value).toLocaleString();
}

export function providerName(provider: string): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "xai") return "xAI";
  return provider;
}

/** CSS class that colors a utilization bar by how close it is to the limit. */
export function usageClass(utilization: number): string {
  if (utilization >= 0.9) return "cc-usage-high";
  if (utilization >= 0.75) return "cc-usage-warn";
  return "cc-usage-ok";
}

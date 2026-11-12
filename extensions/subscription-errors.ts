/** Only subscription exhaustion qualifies for managed fallback recovery. */
export function isSubscriptionLimit(
  provider: string,
  message: string,
): boolean {
  if (provider === 'openai-codex') {
    return /subscription_sharing_usage_limit_exceeded|usage_limit_reached|usage_not_included|hit your chatgpt usage limit|(?:five|5)[- ]hour.{0,30}(?:limit|quota)|(?:usage|quota) limit (?:reached|exceeded)/i.test(
      message,
    );
  }
  if (provider === 'opencode-go') {
    return /GoUsageLimitError|FreeUsageLimitError|monthly usage limit reached|(?:usage|quota) limit (?:reached|exceeded)|quota exceeded/i.test(
      message,
    );
  }
  return false;
}

export const SUBSCRIPTION_FALLBACK_ERROR =
  '503 Subscription allowance exhausted; trying the next configured routing target.';

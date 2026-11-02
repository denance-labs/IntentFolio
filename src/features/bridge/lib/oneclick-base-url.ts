// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0).

/**
 * 1Click's public base URL, shared by the gas purchase and the Converting Withdrawal quote.
 * Env-overridable; `||` handles an empty override.
 */
export const ONE_CLICK_BASE_URL =
  process.env.NEXT_PUBLIC_ONECLICK_BASE_URL || "https://1click.chaindefuser.com";

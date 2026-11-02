// Single source for the portfolio name cap: input maxLength, validation, counter and
// error copy all read it (operator decision 2026-09-28, 016 §5.1 row 1.4). The vault
// allows far more (MAX_PORTFOLIO_NAME_LEN = 128 bytes); 25 keeps names readable in tabs.
export const PORTFOLIO_NAME_MAX_LENGTH = 25;

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validatePortfolioName(
  name: string,
  existingNames: string[],
  currentName?: string
): ValidationResult {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "nameEmpty" };
  }

  if (trimmed.length > PORTFOLIO_NAME_MAX_LENGTH) {
    return { ok: false, error: "nameTooLong" };
  }

  const lower = trimmed.toLowerCase();
  const currentLower = currentName?.toLowerCase();
  const isDuplicate = existingNames.some(
    (n) => n.toLowerCase() === lower && n.toLowerCase() !== currentLower
  );

  if (isDuplicate) {
    return { ok: false, error: "nameDuplicate" };
  }

  return { ok: true };
}

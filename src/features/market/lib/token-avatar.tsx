import type { CSSProperties } from "react";
import { TokenIcon, hasTokenIcon } from "./token-icons";

// Shared token avatar: a circular (or rounded) slot holding the branded token icon,
// falling back to a two-letter monogram only when no branded/local icon exists for the
// symbol. Callers control the background (neutral slate, or a faint colorForSymbol tint
// matching the add-tokens modal) via `className` / `style`. Centralizes the
// "icon-or-initials" decision that used to be duplicated across the balance list,
// withdraw picker and preset review.
export function TokenAvatar({
  symbol,
  size = 28,
  className = "",
  style,
  fallbackClassName = "text-xs font-bold text-slate-300",
}: {
  symbol: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  fallbackClassName?: string;
}) {
  const hasIcon = hasTokenIcon(symbol);
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, ...style }}
      className={`flex shrink-0 items-center justify-center overflow-hidden ${className}`}
    >
      {hasIcon ? (
        <TokenIcon symbol={symbol} size={Math.round(size * 0.82)} />
      ) : (
        <span className={fallbackClassName}>{symbol.slice(0, 2)}</span>
      )}
    </span>
  );
}

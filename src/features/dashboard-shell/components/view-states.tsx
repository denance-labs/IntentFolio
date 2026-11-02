"use client";

import type { ReactNode } from "react";

// Animated pulse rectangle for skeleton layouts.
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-lg bg-slate-800/60 ${className}`}
    />
  );
}

// Generic empty state with optional body and CTA.
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-medium text-slate-400">{title}</p>
      {body && <p className="max-w-xs text-sm leading-relaxed text-slate-400">{body}</p>}
      {action}
    </div>
  );
}

// Inline error banner with optional retry button.
export function ErrorState({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded-2xl border border-amber-700/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-300"
    >
      <p>{message}</p>
      {onRetry && retryLabel && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-lg border border-amber-700/40 px-3 py-1 text-xs font-medium transition hover:bg-amber-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

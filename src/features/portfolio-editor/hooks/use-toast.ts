"use client";

import { useEffect, useState } from "react";
import type { ToastState } from "../types";

export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), toast.durationMs ?? 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return { toast, setToast };
}

import { useState } from "react";
import { useLocation } from "react-router";

type MobilePresentEnv = {
  matchMedia?: typeof window.matchMedia;
  innerWidth: number;
  innerHeight: number;
};

export function detectMobilePresent(search: string, env: MobilePresentEnv): boolean {
  const mobileValues = new URLSearchParams(search).getAll("mobile");
  // Неоднозначный query не должен случайно переключать режим презентации.
  const override = mobileValues.length === 1 && (mobileValues[0] === "0" || mobileValues[0] === "1")
    ? mobileValues[0] === "1"
    : undefined;
  const coarsePointer = env.matchMedia?.("(pointer: coarse)").matches ?? false;

  return override ?? (coarsePointer && Math.min(env.innerWidth, env.innerHeight) < 768);
}

export function useMobilePresent(): boolean {
  const { search } = useLocation();
  // Режим фиксируется на срок жизни шелла, чтобы навигация внутри прототипа не меняла геометрию сцены.
  const [mobilePresent] = useState(() => detectMobilePresent(search, window));
  return mobilePresent;
}

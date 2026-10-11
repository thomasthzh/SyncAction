import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { UiCommandResult } from "../ui/ui-protocol.js";
import { announce } from "./accessibility.js";

/** Feedback for user-initiated commands; the ref also guards clicks in the same render. */
export function useCommandFeedback() {
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run(
    label: string,
    action: () => Promise<UiCommandResult>,
    successMessage?: string | (() => string),
  ): Promise<UiCommandResult | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(label);
    setErrorCode(null);
    setMessage(null);
    try {
      const result = await action();
      if (!mounted.current) return null;
      if (result.ok && successMessage !== undefined) {
        const text = typeof successMessage === "function" ? successMessage() : successMessage;
        setMessage(text);
        announce(text);
      } else if (!result.ok) {
        setErrorCode(result.errorCode);
      }
      return result;
    } catch {
      if (mounted.current) setErrorCode("NETWORK_ERROR");
      return null;
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return { pending, errorCode, message, run, setErrorCode };
}

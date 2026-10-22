import { parsePublicServerOrigin } from "./server-origin.js";

/** The public distribution deliberately ships this exact non-service origin. */
export function isPlaceholderServerOrigin(input: string): boolean {
  try {
    return parsePublicServerOrigin(input) === "https://syncaction.example.com";
  } catch {
    return false;
  }
}

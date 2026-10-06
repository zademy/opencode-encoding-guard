import type { LineEnding } from "./types.js";

export interface LineEndingInfo {
  lineEnding: LineEnding;
  mixed: boolean;
  crlf: number;
  lf: number;
  cr: number;
}

/** Count CRLF / bare LF / bare CR outside of CRLF pairs. */
export function detectLineEndings(text: string): LineEndingInfo {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        crlf++;
        index++;
      } else {
        cr++;
      }
    } else if (code === 10) {
      lf++;
    }
  }
  const kinds = [crlf, lf, cr].filter((count) => count > 0).length;
  if (kinds === 0) return { lineEnding: "LF", mixed: false, crlf, lf, cr };
  const dominant = crlf >= lf && crlf >= cr ? "CRLF" : lf >= cr ? "LF" : "CR";
  return { lineEnding: dominant, mixed: kinds > 1, crlf, lf, cr };
}

/** True when the text already satisfies the target convention (no rewrite needed). */
export function hasLineEnding(text: string, target: LineEnding): boolean {
  const { crlf, lf, cr } = detectLineEndings(text);
  if (target === "CRLF") return lf === 0 && cr === 0;
  if (target === "CR") return lf === 0 && crlf === 0;
  return crlf === 0 && cr === 0;
}

/**
 * Normalise every newline to the target convention.
 *
 * Only call this when `hasLineEnding()` is false: mixed files are reported and
 * left alone unless the configuration explicitly allows normalisation.
 */
export function applyLineEnding(text: string, target: LineEnding): string {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (target === "LF") return normalised;
  if (target === "CRLF") return normalised.replace(/\n/g, "\r\n");
  return normalised.replace(/\n/g, "\r");
}

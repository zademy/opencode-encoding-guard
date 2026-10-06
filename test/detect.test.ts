import { describe, expect, test } from "bun:test";
import {
  analyzeBytes,
  detectBom,
  detectEncoding,
  isBinary,
  isValidUtf8,
} from "../src/core/detect.js";
import { encodeText, UTF8_BOM } from "../src/core/codec.js";
import {
  applyLineEnding,
  detectLineEndings,
  hasLineEnding,
} from "../src/core/line-endings.js";
import { ISO_8859_1_BYTES } from "./helpers.js";

describe("detection", () => {
  test("UTF-8 BOM is detected", () => {
    expect(detectBom(Buffer.concat([UTF8_BOM, Buffer.from("hi")]))).toBe(
      "utf8",
    );
    expect(detectBom(Buffer.from("hi"))).toBeNull();
  });

  test("UTF-16 files are recognised as binary and never touched", () => {
    expect(detectBom(Buffer.from([0xff, 0xfe, 0x68, 0x00]))).toBe("utf16le");
    expect(isBinary(Buffer.from([0xff, 0xfe, 0x68, 0x00]))).toBe(true);
  });

  test("pure ASCII, UTF-8 and legacy bytes are told apart", () => {
    expect(detectEncoding(Buffer.from("plain ascii\n"))).toBe("ascii");
    expect(detectEncoding(encodeText("Información", "utf8"))).toBe("utf8");
    expect(detectEncoding(ISO_8859_1_BYTES)).toBe("iso-8859-1");
  });

  test("bytes in 0x80-0x9F imply Windows-1252 rather than ISO-8859-1", () => {
    expect(detectEncoding(encodeText("€", "windows-1252"))).toBe(
      "windows-1252",
    );
    expect(detectEncoding(encodeText("“x”", "windows-1252"))).toBe(
      "windows-1252",
    );
  });

  test("isValidUtf8 rejects legacy bytes", () => {
    expect(isValidUtf8(encodeText("Información", "utf8"))).toBe(true);
    expect(isValidUtf8(ISO_8859_1_BYTES)).toBe(false);
  });

  test("analyzeBytes reports high bytes and the cp1252 range", () => {
    const evidence = analyzeBytes(ISO_8859_1_BYTES);
    expect(evidence.hasHighBytes).toBe(true);
    expect(evidence.hasCp1252Range).toBe(false);
    expect(evidence.validUtf8).toBe(false);
  });
});

describe("line endings", () => {
  test("detects LF, CRLF and CR", () => {
    expect(detectLineEndings("a\nb\n").lineEnding).toBe("LF");
    expect(detectLineEndings("a\r\nb\r\n").lineEnding).toBe("CRLF");
    expect(detectLineEndings("a\rb\r").lineEnding).toBe("CR");
  });

  test("detects mixed files", () => {
    expect(detectLineEndings("a\r\nb\n").mixed).toBe(true);
    expect(detectLineEndings("a\r\nb\r\n").mixed).toBe(false);
  });

  test("restores the requested convention", () => {
    expect(applyLineEnding("a\nb\n", "CRLF")).toBe("a\r\nb\r\n");
    expect(applyLineEnding("a\r\nb\r\n", "LF")).toBe("a\nb\n");
    expect(applyLineEnding("a\nb\n", "CR")).toBe("a\rb\r");
  });

  test("hasLineEnding is cheap and accurate", () => {
    expect(hasLineEnding("a\r\nb\r\n", "CRLF")).toBe(true);
    expect(hasLineEnding("a\nb\n", "CRLF")).toBe(false);
    expect(hasLineEnding("a\r\nb\n", "LF")).toBe(false);
  });
});

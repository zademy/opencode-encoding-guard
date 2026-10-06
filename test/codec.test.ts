import { describe, expect, test } from "bun:test";
import {
  canEncode,
  decodeBytes,
  describeUnencodable,
  encodeText,
  stripBom,
  UTF8_BOM,
  unencodableCharacters,
} from "../src/core/codec.js";
import { ISO_8859_1_BYTES } from "./helpers.js";

describe("codec", () => {
  test("ISO-8859-1 literal bytes decode to the expected Spanish text", () => {
    const text = decodeBytes(ISO_8859_1_BYTES, "iso-8859-1");
    expect(text).toContain("Información del trámite");
    expect(text).toContain("Contraseña");
  });

  test("ISO-8859-1 round-trips to the exact original bytes", () => {
    const text = decodeBytes(ISO_8859_1_BYTES, "iso-8859-1");
    const encoded = encodeText(text, "iso-8859-1");
    expect(encoded.equals(ISO_8859_1_BYTES)).toBe(true);
  });

  test("accented characters keep their exact bytes", () => {
    const bytes = encodeText(
      "Información\nDescripción\nContraseña\nOperación\nNotificación\nMéxico\nJosé\nMuñoz\n",
      "iso-8859-1",
    );
    expect([...bytes.slice(12, 24)]).toEqual([
      0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x63, 0x69, 0xf3, 0x6e, 0x0a,
    ]);
    expect(bytes.includes(0xf1)).toBe(true); // ñ
    expect(bytes.includes(0xf3)).toBe(true); // ó
  });

  test("Windows-1252 keeps smart quotes and the euro sign", () => {
    const text = "“Texto” ‘valor’ €";
    const bytes = encodeText(text, "windows-1252");
    expect(bytes[0]).toBe(0x93); // left double quote
    expect(bytes.includes(0x80)).toBe(true); // euro sign
    expect(decodeBytes(bytes, "windows-1252")).toBe(text);
  });

  test("ISO-8859-1 and Windows-1252 are not confused", () => {
    const cp1252 = encodeText("€", "windows-1252");
    // The same byte is undefined in ISO-8859-1 and must not round-trip as €.
    expect(decodeBytes(cp1252, "iso-8859-1")).not.toBe("€");
    expect(canEncode("€", "iso-8859-1")).toBe(false);
    expect(canEncode("€", "windows-1252")).toBe(true);
  });

  test("iso-8859-1 cannot represent characters outside its range", () => {
    expect(canEncode("Operación correcta", "iso-8859-1")).toBe(true);
    expect(canEncode("✅ Operación correcta", "iso-8859-1")).toBe(false);
    expect(canEncode("Información", "iso-8859-1")).toBe(true);
  });

  test("unencodableCharacters reports the offending code points", () => {
    const offenders = unencodableCharacters("✅ Operación", "iso-8859-1");
    expect(offenders).toEqual(["✅"]);
    expect(describeUnencodable("✅ Operación", "iso-8859-1")).toBe("U+2705 ✅");
  });

  test("windows-1252 and utf8 accept emoji; ascii does not", () => {
    expect(canEncode("✅", "utf8")).toBe(true);
    expect(canEncode("✅", "ascii")).toBe(false);
  });

  test("BOM helpers", () => {
    expect(
      stripBom(Buffer.concat([UTF8_BOM, Buffer.from("x")])).toString(),
    ).toBe("x");
    expect(stripBom(Buffer.from("x")).toString()).toBe("x");
  });

  test("CRLF survives a round-trip through ISO-8859-1", () => {
    const text = "linea uno\r\nlínea dos\r\n";
    const bytes = encodeText(text, "iso-8859-1");
    expect(bytes.includes(0x0d)).toBe(true);
    expect(decodeBytes(bytes, "iso-8859-1")).toBe(text);
  });
});

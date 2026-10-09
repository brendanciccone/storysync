// The checksum primitives readback seals and element trees share.
//
// They lived in verify.ts until the element tree needed them too: a tree's
// digest is the same FNV-1a over the same canonical JSON, and tree-types.ts is
// imported by the build side as well as by verify, so it can't pull in
// verify's snap and Storybook dependencies to reach two pure functions.
// verify.ts re-exports both unchanged, so nothing that imports them from
// there changes.

/**
 * JSON with every object's keys sorted and no whitespace.
 *
 * Indentation and key order are how a file happens to be written, not what it
 * says, so they must not change the checksum; any change of value must.
 * Numbers are written as JavaScript writes them, the shortest form that reads
 * back as the same double, so 0.0000001, 1E-7 and 1e-7 are one number, while
 * 0.4 and the 0.4000000059604645 Figma reports for it are two. Strings are
 * compared exactly, so a color's case counts, and null is a value where an
 * absent key is not. Mirrors `canon` in the skill's readback template: the
 * two must agree character for character.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 32-bit FNV-1a over a string's UTF-16 code units, as 8 lowercase hex digits.
 *
 * Over the code units rather than UTF-8 bytes because the plugin context has
 * no TextEncoder; for the ASCII a readback is made of, they are the same.
 * Small enough to paste into every readback call, and a checksum, not a
 * cryptographic hash: nothing here could stop a deliberate forger anyway.
 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * 32-bit FNV-1a over raw bytes, as 8 lowercase hex digits: fnv1a32's
 * algorithm, one byte at a time.
 *
 * For image content. snap records the FNV of each thumbnail it writes, and
 * the readback template computes the same over the bytes Figma hands back
 * for an image fill (`getBytesAsync`), so verify can tell whether Figma holds
 * exactly the thumbnail snap made without the file itself, in CI too. A
 * string of ASCII hashes the same as its bytes, so the two functions agree
 * wherever both apply.
 */
export function fnv1a32Bytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

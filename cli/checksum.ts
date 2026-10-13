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

/**
 * The checksum a use_figma call carries of its own data, `const SUM`:
 * fnv1a32 over the JSON of its constants' values, in the order the call
 * declares them.
 *
 * An agent sends each call by pasting the file `storysync figma code` wrote,
 * up to 45,000 characters, and the fourth live push's agent typed `1.790`
 * for `1.79` in an icon's path in one: harmless that time, but nothing
 * would have noticed a change that wasn't. Each template computes this
 * again from the values the call gave it, before it changes or reads
 * anything, and refuses to run when the two differ. JSON.stringify of
 * values parsed from JSON that JSON.stringify wrote gives back the same
 * text, so an honest call always matches, and a value changed anywhere in
 * the call, a string's characters included, doesn't. The template has its
 * own checksum, TSUM (callCode).
 */
export function callSum(values: readonly unknown[]): string {
  return fnv1a32(JSON.stringify(values));
}

/**
 * JSON with every character past ASCII written as its `\u` escape: the
 * same value read back, in characters an agent retyping a call can't turn
 * into others, as a no-break space into a space, which SUM would refuse
 * again on every resend. An escape is only ever inside a string, where
 * JSON and JavaScript read it alike, and SUM is over the values, so it
 * doesn't change.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The lines a call writes before its template: each constant, one a line,
 * as `const NAME = <JSON>;` (asciiJson), then `const SUM = "<callSum of
 * their values>";`.
 */
export function callConstants(constants: readonly (readonly [name: string, value: unknown])[]): string {
  const lines = constants.map(([name, value]) => `const ${name} = ${asciiJson(value)};\n`);
  return `${lines.join("")}const SUM = ${JSON.stringify(callSum(constants.map(([, value]) => value)))};\n`;
}

/** What a call throws, before it changes or reads anything, when its data or its template fails its checksum. */
export function refusal(what: "data" | "template", name: "SUM" | "TSUM"): string {
  return `This call differs from the file storysync figma code wrote: its ${what} fails its checksum, ${name}. Nothing was changed. Send the file again, exactly as it is.`;
}

/** The function a call runs its template as, `const T = <this>;`: TSUM is fnv1a32 over this text. */
export function templateFunction(template: string): string {
  return `async()=>{\n${template}\n}`;
}

/**
 * A call's code after its header comment: its constants and SUM
 * (callConstants), TSUM, the template as the function T, and a guard that
 * checks SUM and then TSUM before T runs, and returns what T returns.
 *
 * The template is 17,000 of a build call's 45,000 characters, and a digit
 * mistyped in one of its numbers, a tolerance or keepLines' 1.27, would
 * change every build without a word. It runs as T so the guard can read
 * its text back: ES2019 has Function.prototype.toString give a function's
 * source text exactly, as V8 does. Nothing yet shows Figma's plugin
 * runtime does: the guard compares TSUM only where it gives back
 * the text of P, a function of T's kind with a line break in it, exactly
 * (TC). A runtime that strips a function's source, or code rewritten on
 * its way, line ends included, then skips the check rather than refusing
 * every honest call; the build returns TC as `tc`, so a live push shows
 * which it was. SUM, over values, is checked either way, and first, so a
 * changed TPL is a call to send again, not a template to doubt.
 */
export function callCode(constants: readonly (readonly [name: string, value: unknown])[], template: string): string {
  const fn = templateFunction(template);
  const names = constants.map(([name]) => name).join(",");
  return [
    `${callConstants(constants)}const TSUM = ${JSON.stringify(fnv1a32(fn))};`,
    `const T = ${fn};`,
    `const fnv=x=>{let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x.charCodeAt(i),16777619)>>>0;return h.toString(16).padStart(8,"0")};`,
    `if(fnv(JSON.stringify([${names}]))!==SUM)throw new Error(${JSON.stringify(refusal("data", "SUM"))});`,
    `const P=async()=>{\nreturn 1.50},TC=String(P)==="async()=>{\\nreturn 1.50}";`,
    `if(TC&&fnv(String(T))!==TSUM)throw new Error(${JSON.stringify(refusal("template", "TSUM"))});`,
    "return await T();",
    "",
  ].join("\n");
}

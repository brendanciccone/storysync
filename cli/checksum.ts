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

/**
 * The template as the JavaScript template literal a call carries it in,
 * `const T = <this>;`: its text exactly, with each backslash, backtick and
 * `${` escaped, so the string the literal makes is the template, which TSUM
 * covers and the call runs. A minified template has no backtick or `${`
 * and a few backslashes, so it costs a few characters; a readable one
 * (`figma code --no-minify`) keeps its lines.
 */
export function templateLiteral(template: string): string {
  return `\`${template.replace(/\\|`|\$\{/g, (m) => `\\${m}`)}\``;
}

/**
 * A call's code after its header comment: its constants and SUM
 * (callConstants), TSUM, the template as the string T (templateLiteral), and
 * a guard that checks SUM, then TSUM, and runs T as the body of an async
 * function of `figma`, the call's constants and TC, returning what it
 * returns.
 *
 * The template is 17,000 of a build call's 45,000 characters, and a digit
 * mistyped in one of its numbers, a tolerance or keepLines' 1.27, would
 * change every build without a word. 0.4.0 ran it as a function and
 * checked the text String() gave back, which ES2019 has be the source, as
 * V8 and Figma's runtime both give it. But use_figma rewrites some calls
 * before they run: the sixth probe (cli/__tests__/fixtures/figma-tsum-probe.json)
 * saw the guard's own `async()=>{\nreturn 1.50}` come back as
 * `async () => {\n      return 1.50;}`, so that guard skipped the check, as
 * it did in every build of the fifth live push (`tc: 0`). A string's
 * characters survive any rewrite that keeps what the code does, and the
 * same probe saw the AsyncFunction constructor compile and run code there.
 * So T is a string: the guard checks the very text it then compiles, every
 * time, and passes TC as 1, which the build returns as `tc`. SUM, over
 * values, is checked first, so a changed TPL is a call to send again, not
 * a template to doubt.
 */
export function callCode(constants: readonly (readonly [name: string, value: unknown])[], template: string): string {
  const names = constants.map(([name]) => name);
  return [
    `${callConstants(constants)}const TSUM = ${JSON.stringify(fnv1a32(template))};`,
    `const T = ${templateLiteral(template)};`,
    `const fnv=x=>{let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x.charCodeAt(i),16777619)>>>0;return h.toString(16).padStart(8,"0")};`,
    `if(fnv(JSON.stringify([${names.join(",")}]))!==SUM)throw new Error(${JSON.stringify(refusal("data", "SUM"))});`,
    `if(fnv(T)!==TSUM)throw new Error(${JSON.stringify(refusal("template", "TSUM"))});`,
    `return await new(async()=>{}).constructor(${["figma", ...names, "TC"].map((n) => JSON.stringify(n)).join(",")},T)(figma,${names.join(",")},1);`,
    "",
  ].join("\n");
}

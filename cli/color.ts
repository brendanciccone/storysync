// CSS colour parsing, shared by snap, diff and tokens.
//
// Chromium's getComputedStyle reports a colour in the space it was authored
// in: Tailwind v4's palette as `oklch(0.637 0.237 25.331)`, its opacity
// modifiers (a color-mix in oklab) as `oklab(0.637 0.214213 0.1014 / 0.5)`, a
// color-mix in sRGB, HSL or HWB as `color(srgb 1 0 0 / 0.5)`, and so on for
// lab(), lch() and every color() space. Hex, named, rgb(), hsl() and hwb()
// colours come back as `rgb()` / `rgba()`. Token sources hold the same forms as
// written. Everything here turns any of them into the one format snap writes,
// verify scores and diff compares: sRGB hex, `#rrggbb`, or `#rrggbbaa` when
// translucent.
//
// The conversions are the sample code in CSS Color 4 ("Sample code for color
// conversions"), whose OKLab matrices are Björn Ottosson's.

/**
 * A colour in sRGB: channels gamma-encoded on 0–255 and not yet clipped, so a
 * colour outside sRGB can still be told from one inside it; alpha on 0–1.
 */
export interface SrgbColor {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

/**
 * Converts any colour a browser can serialise to lowercase `#rrggbb`, or
 * `#rrggbbaa` when it isn't opaque. Null when the value isn't a colour this
 * can read, `color-mix()` included: Chromium's computed value is never one,
 * since it resolves the mix.
 *
 * Hex passes through as written, lowercased and expanded, rather than being
 * re-rounded; an `ff` alpha written out is kept.
 */
export function colorToHex(input: string): string | null {
  const s = clean(input);

  const hex8 = s.match(/^#([0-9a-f]{8})$/);
  if (hex8) return `#${hex8[1]}`;
  const hex6 = s.match(/^#([0-9a-f]{6})$/);
  if (hex6) return `#${hex6[1]}`;
  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`;
  const hex4 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex4) {
    const [, r, g, b, a] = hex4;
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`;
  }
  // Own keys only: `in` would read "constructor" as a colour.
  if (Object.hasOwn(NAMED, s)) return NAMED[s];

  const color = parseColorFunction(s);
  return color ? formatHex(color) : null;
}

/**
 * Formats an sRGB colour as snap writes it, clipping each channel to sRGB.
 *
 * Clipping is the gamut mapping, and on purpose: Figma's fills are sRGB here,
 * so a colour outside sRGB (a display-p3 red, or one of Tailwind v4's more
 * saturated oklch shades) has to land on the nearest value a fill can hold.
 * Clipping is also what Chromium paints on an sRGB canvas: red-600,
 * `oklch(57.7% 0.245 27.325)`, is about (0.906, -0.096, 0.042) in sRGB and
 * paints as `#e7000b`. CSS Color 4's own gamut mapping reduces chroma in
 * OKLCH instead, and would give such a colour another hex.
 */
export function formatHex(color: SrgbColor): string | null {
  const { r, g, b, alpha } = color;
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  const byte = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  const hex = `#${byte(r)}${byte(g)}${byte(b)}`;
  const a = byte(alpha * 255);
  return a === "ff" ? hex : `${hex}${a}`;
}

function clean(input: string): string {
  return input.trim().toLowerCase().replace(/;$/, "").replace(/^['"]|['"]$/g, "").trim();
}

// Named CSS colors — small subset that designers commonly use.
const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "#00000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
};

// --- Parsing ------------------------------------------------------------------

/** Parses `name(...)` for every colour function above, or null. */
function parseColorFunction(s: string): SrgbColor | null {
  const fn = s.match(/^([a-z][a-z0-9-]*)\(([^()]*)\)$/);
  if (!fn) return null;
  const [, name, body] = fn;
  const args = splitArguments(body);
  if (!args) return null;
  let { parts, alpha } = args;

  // Only rgb() and hsl() have the legacy comma syntax, which carries alpha as
  // a fourth argument.
  if (args.commas) {
    if (!/^(?:rgba?|hsla?)$/.test(name)) return null;
    if (alpha == null && parts.length === 4) {
      alpha = parts[3];
      parts = parts.slice(0, 3);
    }
  }

  const a = parseAlpha(alpha);
  if (a == null) return null;

  if (name === "color") {
    if (parts.length !== 4) return null;
    const [space, ...channels] = parts;
    const values = channels.map((t) => component(t, 1));
    if (!isTriple(values)) return null;
    const srgb = predefinedToSrgb(space, values);
    return srgb ? withAlpha(srgb, a) : null;
  }

  if (parts.length !== 3) return null;
  const [t1, t2, t3] = parts;

  switch (name) {
    case "rgb":
    case "rgba": {
      const values = [component(t1, 255), component(t2, 255), component(t3, 255)];
      if (!isTriple(values)) return null;
      return { r: values[0], g: values[1], b: values[2], alpha: a };
    }
    case "hsl":
    case "hsla": {
      const h = hue(t1);
      const sat = component(t2, 100);
      const light = component(t3, 100);
      if (h == null || sat == null || light == null) return null;
      return withAlpha(hslToSrgb(h, sat / 100, light / 100), a);
    }
    case "hwb": {
      const h = hue(t1);
      const white = component(t2, 100);
      const black = component(t3, 100);
      if (h == null || white == null || black == null) return null;
      return withAlpha(hwbToSrgb(h, white / 100, black / 100), a);
    }
    case "lab": {
      const values = [component(t1, 100), component(t2, 125), component(t3, 125)];
      if (!isTriple(values)) return null;
      return withAlpha(labToSrgb([clamp(values[0], 0, 100), values[1], values[2]]), a);
    }
    case "lch": {
      const l = component(t1, 100);
      const c = component(t2, 150);
      const h = hue(t3);
      if (l == null || c == null || h == null) return null;
      return withAlpha(labToSrgb(polarToCartesian([clamp(l, 0, 100), Math.max(0, c), h])), a);
    }
    case "oklab": {
      const values = [component(t1, 1), component(t2, 0.4), component(t3, 0.4)];
      if (!isTriple(values)) return null;
      return withAlpha(oklabToSrgb([clamp(values[0], 0, 1), values[1], values[2]]), a);
    }
    case "oklch": {
      const l = component(t1, 1);
      const c = component(t2, 0.4);
      const h = hue(t3);
      if (l == null || c == null || h == null) return null;
      return withAlpha(oklabToSrgb(polarToCartesian([clamp(l, 0, 1), Math.max(0, c), h])), a);
    }
    default:
      return null;
  }
}

/**
 * Splits a function's arguments: space-separated with an optional `/ alpha`,
 * or the legacy comma-separated form. Null when an argument is empty or holds
 * more than one token.
 */
function splitArguments(body: string): { parts: string[]; alpha: string | null; commas: boolean } | null {
  const slashed = body.split("/");
  if (slashed.length > 2) return null;
  const commas = slashed[0].includes(",");
  const parts = commas ? slashed[0].split(",").map((p) => p.trim()) : slashed[0].trim().split(/\s+/);
  const alpha = slashed.length === 2 ? slashed[1].trim() : null;
  const single = (t: string) => t !== "" && !/\s/.test(t);
  if (!parts.every(single) || (alpha != null && !single(alpha))) return null;
  return { parts, alpha, commas };
}

const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/;

function parseNumber(token: string): { n: number; unit: string } | null {
  const m = token.match(NUMBER);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? { n, unit: m[2] } : null;
}

/**
 * A channel: a number, or a percentage of `percent`, the value 100% stands
 * for in that channel (255 for rgb(), 0.4 for OKLCH's chroma, 1 for color()).
 * `none`, a missing component, is zero, as it is when a browser draws one.
 */
function component(token: string, percent: number): number | null {
  if (token === "none") return 0;
  const p = parseNumber(token);
  if (!p) return null;
  if (p.unit === "%") return (p.n / 100) * percent;
  return p.unit === "" ? p.n : null;
}

const DEGREES_PER: Record<string, number> = { "": 1, deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/** A hue in degrees, from a number or any angle unit; `none` is zero. */
function hue(token: string): number | null {
  if (token === "none") return 0;
  const p = parseNumber(token);
  if (!p) return null;
  const scale = DEGREES_PER[p.unit];
  return scale == null ? null : p.n * scale;
}

/** Alpha from a number or a percentage, clamped to 0–1; absent is opaque, `none` is zero. */
function parseAlpha(token: string | null): number | null {
  if (token == null) return 1;
  const a = component(token, 1);
  return a == null ? null : clamp(a, 0, 1);
}

function isTriple(values: (number | null)[]): values is [number, number, number] {
  return values.length === 3 && values.every((v) => v != null);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// --- Conversion ---------------------------------------------------------------

type Vec3 = [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

function multiply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Gamma-encoded sRGB on 0–1 to the 0–255 channels SrgbColor holds. */
function withAlpha(srgb: Vec3, alpha: number): SrgbColor {
  return { r: srgb[0] * 255, g: srgb[1] * 255, b: srgb[2] * 255, alpha };
}

function hslToSrgb(h: number, s: number, l: number): Vec3 {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function hwbToSrgb(h: number, white: number, black: number): Vec3 {
  if (white + black >= 1) {
    const gray = white / (white + black);
    return [gray, gray, gray];
  }
  return hslToSrgb(h, 1, 0.5).map((c) => c * (1 - white - black) + white) as Vec3;
}

/** LCH or OKLCH to Lab or OKLab: chroma and hue to the two opponent axes. */
function polarToCartesian([l, c, h]: Vec3): Vec3 {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

// Transfer functions: gamma-encoded to linear light, sign-preserving so a
// value outside 0–1 (out of gamut) still converts.

function srgbToLinear(c: number): number {
  const abs = Math.abs(c);
  return abs <= 0.04045 ? c / 12.92 : Math.sign(c) * ((abs + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const abs = Math.abs(c);
  return abs > 0.0031308 ? Math.sign(c) * (1.055 * abs ** (1 / 2.4) - 0.055) : 12.92 * c;
}

function a98ToLinear(c: number): number {
  return Math.sign(c) * Math.abs(c) ** (563 / 256);
}

function prophotoToLinear(c: number): number {
  const abs = Math.abs(c);
  return abs <= 16 / 512 ? c / 16 : Math.sign(c) * abs ** 1.8;
}

function rec2020ToLinear(c: number): number {
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  const abs = Math.abs(c);
  return abs < beta * 4.5 ? c / 4.5 : Math.sign(c) * ((abs + alpha - 1) / alpha) ** (1 / 0.45);
}

// Matrices to and from CIE XYZ, D65 unless named D50.

const XYZ_TO_LINEAR_SRGB: Mat3 = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];

const LINEAR_P3_TO_XYZ: Mat3 = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
];

const LINEAR_A98_TO_XYZ: Mat3 = [
  [573536 / 994567, 263643 / 1420810, 187206 / 994567],
  [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
  [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
];

const LINEAR_PROPHOTO_TO_XYZ_D50: Mat3 = [
  [0.7977666449006423, 0.13518129740053308, 0.0313477341283922],
  [0.2880748288194013, 0.711835234241873, 0.00008993693872564],
  [0, 0, 0.8251046025104602],
];

const LINEAR_REC2020_TO_XYZ: Mat3 = [
  [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
  [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
  [0, 19567812 / 697040785, 295819943 / 278816314],
];

/** Bradford chromatic adaptation from a D50 white to D65. */
const D50_TO_D65: Mat3 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];

const OKLAB_TO_LMS: Mat3 = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];

const LMS_TO_XYZ: Mat3 = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];

const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function xyzToSrgb(xyz: Vec3): Vec3 {
  return multiply(XYZ_TO_LINEAR_SRGB, xyz).map(linearToSrgb) as Vec3;
}

function labToSrgb([l, a, b]: Vec3): Vec3 {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xyz: Vec3 = [
    fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa,
    l > kappa * epsilon ? fy ** 3 : l / kappa,
    fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa,
  ];
  return xyzToSrgb(multiply(D50_TO_D65, [xyz[0] * D50_WHITE[0], xyz[1] * D50_WHITE[1], xyz[2] * D50_WHITE[2]]));
}

function oklabToSrgb(lab: Vec3): Vec3 {
  const lms = multiply(OKLAB_TO_LMS, lab).map((c) => c ** 3) as Vec3;
  return xyzToSrgb(multiply(LMS_TO_XYZ, lms));
}

/** A color() space's channels to gamma-encoded sRGB, or null for a space this doesn't know. */
function predefinedToSrgb(space: string, [c1, c2, c3]: Vec3): Vec3 | null {
  const linear = (f: (c: number) => number): Vec3 => [f(c1), f(c2), f(c3)];
  switch (space) {
    case "srgb":
      return [c1, c2, c3];
    case "srgb-linear":
      return linear(linearToSrgb);
    case "display-p3":
      return xyzToSrgb(multiply(LINEAR_P3_TO_XYZ, linear(srgbToLinear)));
    case "display-p3-linear":
      return xyzToSrgb(multiply(LINEAR_P3_TO_XYZ, [c1, c2, c3]));
    case "a98-rgb":
      return xyzToSrgb(multiply(LINEAR_A98_TO_XYZ, linear(a98ToLinear)));
    case "prophoto-rgb":
      return xyzToSrgb(multiply(D50_TO_D65, multiply(LINEAR_PROPHOTO_TO_XYZ_D50, linear(prophotoToLinear))));
    case "rec2020":
      return xyzToSrgb(multiply(LINEAR_REC2020_TO_XYZ, linear(rec2020ToLinear)));
    case "xyz":
    case "xyz-d65":
      return xyzToSrgb([c1, c2, c3]);
    case "xyz-d50":
      return xyzToSrgb(multiply(D50_TO_D65, [c1, c2, c3]));
    default:
      return null;
  }
}

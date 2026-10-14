// Tailwind's default color palette, as the project's own Tailwind declares
// it, for the per-mode variables of a palette pair (figma-bind.ts): shadcn/ui's
// AspectRatio story paints `bg-slate-50 dark:bg-slate-900`, and no token
// names either color, so the variable's Dark value can only come from the
// palette. snap measures the light theme, so it never sees slate-900.
//
// Tailwind 4 declares the palette in `tailwindcss/theme.css` as
// `--color-slate-900: oklch(...)`; Tailwind 3 in `tailwindcss/colors.js`, as
// hex literals in nested objects. Both are read as text, never run, from
// the `node_modules/tailwindcss` nearest the project, and a project without
// one has no palette: its palette pairs stay unbound, as before.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tokenColorToHex } from "./tokens.js";

/** Each palette color by its class name (`slate-900`, `white`), as `#rrggbb(aa)`; `transparent` is `#00000000`. */
export type Palette = Map<string, string>;

/** The palette of the Tailwind installed for `projectDir`, or an empty one. */
export function tailwindPalette(projectDir: string): Palette {
  const palette: Palette = new Map();
  const dir = tailwindDir(projectDir);
  if (!dir) return palette;
  const v4 = join(dir, "theme.css");
  const v3 = join(dir, "lib", "public", "colors.js");
  if (existsSync(v4)) readThemeCss(readFileSync(v4, "utf8"), palette);
  else if (existsSync(v3)) readColorsJs(readFileSync(v3, "utf8"), palette);
  if (palette.size) palette.set("transparent", "#00000000");
  return palette;
}

/** The `node_modules/tailwindcss` nearest `from`, walking up, or null. */
function tailwindDir(from: string): string | null {
  for (let at = resolve(from); ; at = dirname(at)) {
    const dir = join(at, "node_modules", "tailwindcss");
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(at) === at) return null;
  }
}

/** Tailwind 4's `--color-<name>: <value>;` declarations. */
export function readThemeCss(css: string, into: Palette = new Map()): Palette {
  for (const m of css.matchAll(/--color-([a-z]+(?:-\d+)?)\s*:\s*([^;]+);/g)) {
    const hex = tokenColorToHex(m[2].trim());
    if (hex) into.set(m[1], hex.toLowerCase());
  }
  return into;
}

/** Tailwind 3's `colors.js`: `black: "#000"`, and `slate: { 50: "#f8fafc", ... }`. */
export function readColorsJs(js: string, into: Palette = new Map()): Palette {
  const full = (hex: string) => tokenColorToHex(hex)?.toLowerCase() ?? null;
  for (const m of js.matchAll(/^\s*([a-z]\w*):\s*\{([^{}]*)\}/gm)) {
    for (const step of m[2].matchAll(/(\d+):\s*["'](#[0-9a-fA-F]{3,8})["']/g)) {
      const hex = full(step[2]);
      if (hex) into.set(`${m[1]}-${step[1]}`, hex);
    }
  }
  for (const m of js.matchAll(/^\s*([a-z]\w*):\s*["'](#[0-9a-fA-F]{3,8})["']/gm)) {
    const hex = full(m[2]);
    if (hex) into.set(m[1], hex);
  }
  return into;
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readColorsJs, readThemeCss, tailwindPalette } from "../palette.js";

test("palette: Tailwind 4's theme.css and Tailwind 3's colors.js, read as text, as #rrggbb by class name", () => {
  const v4 = readThemeCss("@theme default {\n  --color-slate-50: oklch(98.4% 0.003 247.858);\n  --color-slate-900: oklch(20.8% 0.042 265.755);\n  --color-black: #000;\n  --spacing: 0.25rem;\n}");
  assert.deepEqual([...v4], [["slate-50", "#f8fafc"], ["slate-900", "#0f172b"], ["black", "#000000"]]);
  const v3 = readColorsJs('const _default = {\n    inherit: "inherit",\n    black: "#000",\n    white: "#fff",\n    slate: {\n        50: "#f8fafc",\n        900: "#0f172a"\n    },\n};');
  assert.deepEqual([...v3].sort(), [["black", "#000000"], ["slate-50", "#f8fafc"], ["slate-900", "#0f172a"], ["white", "#ffffff"]]);
});

test("palette: the project's nearest node_modules/tailwindcss, walking up; none, none", () => {
  const dir = mkdtempSync(join(tmpdir(), "storysync-palette-"));
  assert.equal(tailwindPalette(join(dir, "app")).size, 0);
  mkdirSync(join(dir, "node_modules", "tailwindcss"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "tailwindcss", "package.json"), "{}");
  writeFileSync(join(dir, "node_modules", "tailwindcss", "theme.css"), "--color-red-500: #fb2c36;");
  mkdirSync(join(dir, "app"));
  assert.deepEqual([...tailwindPalette(join(dir, "app"))], [["red-500", "#fb2c36"], ["transparent", "#00000000"]]);
});

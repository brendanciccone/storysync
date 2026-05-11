import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectComponent,
  findComponentFile,
  parseCvaCall,
  parseCnCall,
  parseStyleObjectMap,
  parseStyleMapAsCva,
} from "../inspect.js";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "storysync-inspect-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    const parent = dirname(full);
    if (parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// --- findComponentFile ---

test("findComponentFile: locates by basename in src/components", () => {
  const dir = makeProject({
    "src/components/button.tsx": "export const Button = () => null;",
  });
  try {
    const found = findComponentFile(dir, "button");
    assert.ok(found);
    assert.ok(found!.endsWith("button.tsx"));
  } finally {
    cleanup(dir);
  }
});

test("findComponentFile: case-insensitive match", () => {
  const dir = makeProject({
    "src/components/Button.tsx": "export const Button = () => null;",
  });
  try {
    assert.ok(findComponentFile(dir, "button"));
  } finally {
    cleanup(dir);
  }
});

test("findComponentFile: explicit relative path", () => {
  const dir = makeProject({
    "src/ui/foo.tsx": "export const Foo = () => null;",
  });
  try {
    const found = findComponentFile(dir, "src/ui/foo.tsx");
    assert.ok(found);
    assert.ok(found!.endsWith("foo.tsx"));
  } finally {
    cleanup(dir);
  }
});

test("findComponentFile: returns null when missing", () => {
  const dir = makeProject({ "package.json": "{}" });
  try {
    assert.equal(findComponentFile(dir, "nonexistent"), null);
  } finally {
    cleanup(dir);
  }
});

test("findComponentFile: category hint disambiguates same-basename files", () => {
  // Real-world: a project that uses both Catalyst (Tailwind UI's design
  // system) and a hand-rolled `components/ui/` set ends up with TWO
  // button.tsx files. Without a category hint, the shorter path won.
  // With the hint we route by the directory segment matching the category.
  const dir = makeProject({
    "components/catalyst/button.tsx": "// catalyst button",
    "components/ui/button.tsx": "// ui button",
  });
  try {
    const catalyst = findComponentFile(dir, "button", "Catalyst");
    assert.ok(catalyst);
    assert.match(catalyst!, /catalyst[\\/]+button\.tsx$/i);

    const ui = findComponentFile(dir, "button", "UI");
    assert.ok(ui);
    assert.match(ui!, /ui[\\/]+button\.tsx$/i);

    // No hint: deterministic fallback (shortest path among ties — `ui` wins).
    const noHint = findComponentFile(dir, "button");
    assert.ok(noHint);
  } finally {
    cleanup(dir);
  }
});

test("findComponentFile: skips node_modules and dist", () => {
  const dir = makeProject({
    "node_modules/button.tsx": "//",
    "dist/button.tsx": "//",
    "src/components/button.tsx": "export const Button = () => null;",
  });
  try {
    const found = findComponentFile(dir, "button");
    assert.ok(found);
    // Path-separator tolerant — Windows uses backslashes.
    assert.match(found!, /src[\\/]+components[\\/]+button\.tsx$/i);
  } finally {
    cleanup(dir);
  }
});

// --- parseCvaCall ---

test("parseCvaCall: simple call with one variant", () => {
  const source = `
import { cva } from "class-variance-authority";

const button = cva("inline-flex items-center", {
  variants: {
    variant: {
      primary: "bg-blue-500 text-white",
      secondary: "bg-gray-200 text-gray-900",
    },
  },
  defaultVariants: { variant: "primary" },
});
`;
  const parsed = parseCvaCall(source);
  assert.ok(parsed);
  assert.equal(parsed!.base, "inline-flex items-center");
  assert.deepEqual(Object.keys(parsed!.variants), ["variant"]);
  assert.equal(parsed!.variants.variant.primary, "bg-blue-500 text-white");
  assert.equal(parsed!.variants.variant.secondary, "bg-gray-200 text-gray-900");
  assert.equal(parsed!.defaults.variant, "primary");
});

test("parseCvaCall: multiple variants and template literal base", () => {
  const source = `
const button = cva(
  \`inline-flex items-center
   rounded-md font-medium\`,
  {
    variants: {
      variant: { primary: "bg-blue-500", secondary: "bg-gray-200" },
      size:    { sm: "px-2 py-1 text-sm", md: "px-4 py-2 text-base" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);
`;
  const parsed = parseCvaCall(source);
  assert.ok(parsed);
  assert.match(parsed!.base, /rounded-md font-medium/);
  assert.equal(Object.keys(parsed!.variants).length, 2);
  assert.equal(parsed!.variants.size.sm, "px-2 py-1 text-sm");
  assert.equal(parsed!.defaults.size, "md");
});

test("parseCvaCall: ignores cva mention in import line", () => {
  const source = `import { cva } from "cva";\n// no actual call`;
  assert.equal(parseCvaCall(source), null);
});

test("parseCvaCall: returns null when no cva call", () => {
  assert.equal(parseCvaCall(`export const Button = () => null;`), null);
});

// --- inspectComponent: end-to-end ---

test("inspectComponent: resolves CVA + Tailwind to per-variant styling", () => {
  const dir = makeProject({
    "src/components/button.tsx": `
import { cva } from "class-variance-authority";

const buttonVariants = cva("inline-flex items-center font-medium rounded-md", {
  variants: {
    variant: {
      primary: "bg-blue-500 text-white",
      secondary: "bg-gray-200 text-gray-900",
    },
    size: {
      sm: "px-2 py-1 text-sm",
      md: "px-4 py-2 text-base",
    },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

export const Button = (props: any) => <button className={buttonVariants(props)} {...props} />;
`,
  });
  try {
    const result = inspectComponent(dir, "button");
    assert.ok(result);
    assert.equal(result!.name, "button");

    // Base styling carries the shared classes.
    assert.equal(result!.base.fontWeight, "500");
    assert.equal(result!.base.borderRadius, "6px");

    const variant = result!.variants.find((v) => v.name === "variant");
    assert.ok(variant);
    assert.equal(variant!.defaultValue, "primary");
    assert.equal(variant!.values.primary.fill, "#3b82f6");
    assert.equal(variant!.values.primary.text, "#ffffff");
    assert.equal(variant!.values.secondary.fill, "#e5e7eb");
    assert.equal(variant!.values.secondary.text, "#111827");

    const size = result!.variants.find((v) => v.name === "size");
    assert.ok(size);
    assert.equal(size!.values.sm.padding, "4px 8px 4px 8px");
    assert.equal(size!.values.sm.fontSize, "14px");
    assert.equal(size!.values.md.padding, "8px 16px 8px 16px");
    assert.equal(size!.values.md.fontSize, "16px");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: reports unresolved utilities honestly", () => {
  const dir = makeProject({
    "src/components/widget.tsx": `
import { cva } from "cva";
const w = cva("custom-mystery-class", {
  variants: { tone: { weird: "bg-mystical-glow" } },
});
`,
  });
  try {
    const result = inspectComponent(dir, "widget");
    assert.ok(result);
    assert.ok(result!.unresolved.includes("custom-mystery-class"));
    assert.ok(result!.unresolved.includes("bg-mystical-glow"));
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: arbitrary value bg-[#hex] resolves", () => {
  const dir = makeProject({
    "src/components/odd.tsx": `
import { cva } from "cva";
const o = cva("bg-[#abcdef]");
`,
  });
  try {
    const result = inspectComponent(dir, "odd");
    assert.ok(result);
    assert.equal(result!.base.fill, "#abcdef");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: returns null when component not found", () => {
  const dir = makeProject({ "package.json": "{}" });
  try {
    assert.equal(inspectComponent(dir, "missing"), null);
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: falls back to inline className when no cva", () => {
  const dir = makeProject({
    "src/components/card.tsx": `
export const Card = ({ children }) => (
  <div className="bg-white rounded-lg p-4 shadow-md">{children}</div>
);
`,
  });
  try {
    const result = inspectComponent(dir, "card");
    assert.ok(result);
    assert.equal(result!.base.fill, "#ffffff");
    assert.equal(result!.base.borderRadius, "8px");
    assert.equal(result!.base.padding, "16px 16px 16px 16px");
    assert.ok(result!.warnings.some((w) => w.includes("No variant pattern detected")));
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: reads project tokens to resolve named colors", () => {
  // Tokens defined via Tailwind config should resolve `bg-primary` via the
  // project's token map rather than falling through to unresolved.
  const dir = makeProject({
    "tailwind.config.js": `
module.exports = {
  theme: {
    extend: {
      colors: { primary: "#1234ab" },
    },
  },
};
`,
    "src/components/btn.tsx": `
import { cva } from "cva";
const b = cva("bg-primary text-white");
`,
  });
  try {
    const result = inspectComponent(dir, "btn");
    assert.ok(result);
    assert.equal(result!.base.fill, "#1234ab");
    assert.equal(result!.base.text, "#ffffff");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: skips modifier-prefixed classes (hover/dark/md)", () => {
  // Modifier-prefixed classes represent state changes, not the default.
  // Figma frames are the default state, so we want bg-blue-500 and ignore
  // any hover/dark/responsive variants. Previously these were stripped of
  // their prefix and applied, which made `dark:bg-zinc-900` overwrite the
  // real default `bg-blue-500`.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("bg-blue-500 hover:bg-blue-700 dark:bg-zinc-900 md:px-8");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#3b82f6");      // not #1d4ed8 or #18181b
    assert.equal(result!.base.padding, undefined);    // md:px-8 was skipped
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: arbitrary values with colons are not treated as prefixes", () => {
  // Inside `[...]` brackets, colons are part of the value (e.g. `data-[state=open]`,
  // `bg-[url(http://...)]`). Don't strip these.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("bg-[#abcdef] rounded-[10px]");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#abcdef");
    assert.equal(result!.base.borderRadius, "10px");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: handles bg-{color}/{opacity} by stripping the opacity", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("bg-zinc-900/60");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#18181b");   // strips /60, resolves zinc-900
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: parses cn() with comments interleaved between args", () => {
  // Real-world pattern: maintainers add // section comments between
  // conditional class strings. Previously the comment + the next arg
  // became one un-parseable arg, silently dropping that variant value.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cn } from '@/lib/utils';
export const X = ({ variant = 'primary' }) => (
  <button
    className={cn(
      'rounded-md',
      // Solid variants
      variant === 'primary' && 'bg-blue-600 text-white',
      variant === 'success' && 'bg-emerald-600 text-white',
      // Subtle variants
      variant === 'ghost' && 'bg-transparent',
    )}
  />
);
`,
  });
  try {
    const result = inspectComponent(dir, "X");
    assert.ok(result);
    const variant = result!.variants.find((v) => v.name === "variant");
    assert.ok(variant);
    // All three variants should be present — primary and ghost previously vanished.
    assert.deepEqual(Object.keys(variant!.values).sort(), ["ghost", "primary", "success"]);
    assert.equal(variant!.values.primary.fill, "#2563eb");
    assert.equal(variant!.values.success.fill, "#059669");
  } finally {
    cleanup(dir);
  }
});

// --- Typography expansion ---

test("inspectComponent: text-{align} resolves to textAlign field", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("text-center");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.textAlign, "center");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: text-transform / text-decoration / font-style", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("uppercase italic underline");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.textTransform, "uppercase");
    assert.equal(result!.base.fontStyle, "italic");
    assert.equal(result!.base.textDecoration, "underline");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: font-{family} bundled fallback (no token)", () => {
  // Without a project token, font-sans/font-mono falls back to the bundled
  // family stack — useful as a hint to the agent, no binding.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("font-sans");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.match(result!.base.fontFamily ?? "", /sans-serif/);
    assert.equal(result!.baseBindings.fontFamily, undefined);
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: font-{custom} binds to project typography token via CSS vars", () => {
  // The CSS-var extractor categorizes `--font-display` as typography, so
  // `font-display` should look it up and bind.
  const dir = makeProject({
    "src/styles.css": `:root { --font-display: "Pretendard", sans-serif; }`,
    "src/components/y.tsx": `
import { cva } from "cva";
const y = cva("font-display");
`,
  });
  try {
    const result = inspectComponent(dir, "y");
    assert.ok(result);
    assert.match(result!.base.fontFamily ?? "", /Pretendard/);
    assert.deepEqual(result!.baseBindings.fontFamily, { token: "font-display", collection: "typography" });
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: font-{weight} keeps existing behavior, binds when token defines weight", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("font-medium");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fontWeight, "500");
    assert.equal(result!.baseBindings.fontWeight, undefined);   // bundled, no binding
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: leading-{value} and tracking-{value}", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("leading-tight tracking-wide leading-[1.45]");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    // The arbitrary value wins because it's processed last.
    assert.equal(result!.base.lineHeight, "1.45");
    assert.equal(result!.base.letterSpacing, "0.025em");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: items- and justify- emit alignment fields", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("flex items-center justify-between gap-2");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.alignItems, "center");
    assert.equal(result!.base.justifyContent, "between");
    assert.equal(result!.base.gap, "8px");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: border-{style} resolves to borderStyle", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("border border-dashed border-zinc-200");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.borderStyle, "dashed");
    assert.equal(result!.base.borderColor, "#e4e4e7");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: opacity-{N} normalizes to 0..1 fraction", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("opacity-50");
`,
    "src/components/y.tsx": `
import { cva } from "cva";
const y = cva("opacity-[0.85]");
`,
  });
  try {
    const xResult = inspectComponent(dir, "x");
    const yResult = inspectComponent(dir, "y");
    assert.equal(xResult!.base.opacity, "0.5");
    assert.equal(yResult!.base.opacity, "0.85");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: gap-x and gap-y resolve to gap field", () => {
  // Tailwind splits gap into directional variants. Figma's gap is single-
  // valued so we keep last-wins; common case is one direction or both equal.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("gap-x-1.5");
`,
    "src/components/y.tsx": `
import { cva } from "cva";
const y = cva("gap-y-3");
`,
  });
  try {
    const xResult = inspectComponent(dir, "x");
    const yResult = inspectComponent(dir, "y");
    assert.equal(xResult!.base.gap, "6px");
    assert.equal(yResult!.base.gap, "12px");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: text-{size}/{lh} shorthand sets both fontSize and lineHeight", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("text-sm/5");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fontSize, "14px");        // text-sm
    assert.equal(result!.base.lineHeight, "20px");      // /5 → 5 * 4 = 20px
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: text-{size}/{namedLh} shorthand", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("text-base/relaxed");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fontSize, "16px");
    assert.equal(result!.base.lineHeight, "1.625");     // named "relaxed"
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: emerald and other expanded palette colors resolve", () => {
  // The bundled palette previously omitted emerald, sky, indigo's full ramp,
  // violet, fuchsia, rose, lime, teal, cyan — common shadcn variant colors.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("bg-emerald-600 text-sky-500 border-rose-300");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#059669");
    assert.equal(result!.base.text, "#0ea5e9");
    assert.equal(result!.base.borderColor, "#fda4af");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: warns when compoundVariants are present", () => {
  // The CVA compoundVariants list applies styling only when multiple variant
  // values co-occur — Figma's per-axis variant model can't represent that,
  // so we surface a warning rather than silently dropping the styles.
  const dir = makeProject({
    "src/components/button.tsx": `
import { cva } from "cva";
export const button = cva("rounded-md", {
  variants: {
    variant: { primary: "bg-blue-500", secondary: "bg-gray-500" },
    size: { sm: "p-2", lg: "p-4" },
  },
  compoundVariants: [
    { variant: "primary", size: "sm", class: "ring-2" },
    { variant: "secondary", size: "lg", class: "shadow-lg" },
  ],
  defaultVariants: { variant: "primary", size: "sm" },
});
`,
  });
  try {
    const result = inspectComponent(dir, "Button");
    assert.ok(result);
    assert.ok(
      result!.warnings.some((w) => w.includes("2 compoundVariants")),
      `expected compoundVariants warning, got: ${result!.warnings.join(" / ")}`,
    );
    // Regular variants still resolved correctly.
    const variant = result!.variants.find((v) => v.name === "variant");
    assert.ok(variant);
    assert.equal(variant!.values.primary.fill, "#3b82f6");
  } finally {
    cleanup(dir);
  }
});

test("parseCvaCall: counts compoundVariants without parsing them", () => {
  const source = `
import { cva } from "cva";
const x = cva("base", {
  variants: { size: { sm: "p-1", md: "p-2" } },
  compoundVariants: [
    { size: "sm", class: "a" },
    { size: "md", class: "b" },
    { size: "md", class: "c" },
  ],
});
`;
  const parsed = parseCvaCall(source);
  assert.ok(parsed);
  assert.equal(parsed!.compoundCount, 3);
});

test("parseCvaCall: compoundCount is 0 when field absent", () => {
  const parsed = parseCvaCall(`
import { cva } from "cva";
const x = cva("base", { variants: { size: { sm: "p-1" } } });
`);
  assert.ok(parsed);
  assert.equal(parsed!.compoundCount, 0);
});

// --- Token bindings ---

test("inspectComponent: emits bindings when fill came from a project color token", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { colors: { primary: "#0066ff", danger: "#ff0044" } } } };`,
    "src/components/button.tsx": `
import { cva } from "cva";
export const button = cva("rounded-md", {
  variants: {
    variant: {
      primary: "bg-primary text-white",
      danger: "bg-danger text-white",
    },
  },
});
`,
  });
  try {
    const result = inspectComponent(dir, "Button");
    assert.ok(result);
    const variant = result!.variants.find((v) => v.name === "variant");
    assert.ok(variant);

    // primary: fill resolved through tokens.colors → binding present.
    assert.equal(variant!.values.primary.fill, "#0066ff");
    assert.deepEqual(variant!.bindings.primary.fill, { token: "primary", collection: "colors" });

    // danger: same shape, different token name.
    assert.deepEqual(variant!.bindings.danger.fill, { token: "danger", collection: "colors" });

    // text: white came from CSS_NAMED_COLORS, not a project token → no binding.
    assert.equal(variant!.values.primary.text, "#ffffff");
    assert.equal(variant!.bindings.primary.text, undefined);
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: arbitrary-value bg-[#hex] does NOT bind", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("bg-[#abcdef]");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#abcdef");
    assert.equal(result!.baseBindings.fill, undefined);
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: shadow and radius bind to project tokens", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { boxShadow: { card: "0 4px 12px rgba(0,0,0,0.1)" }, borderRadius: { pill: "9999px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("shadow-card rounded-pill");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.deepEqual(result!.baseBindings.shadow, { token: "card", collection: "shadows" });
    assert.deepEqual(result!.baseBindings.borderRadius, { token: "pill", collection: "radius" });
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: project tokens override Tailwind defaults", () => {
  // `rounded-md` resolves to the project's value when defined, not the
  // bundled "6px" default.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { borderRadius: { md: "10px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("rounded-md");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.borderRadius, "10px");
    assert.deepEqual(result!.baseBindings.borderRadius, { token: "md", collection: "radius" });
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: bindings absent when no project tokens", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("bg-blue-500 rounded-md shadow-sm");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#3b82f6");
    assert.equal(result!.baseBindings.fill, undefined);
    assert.equal(result!.baseBindings.borderRadius, undefined);
    assert.equal(result!.baseBindings.shadow, undefined);
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: rem-valued spacing token converts to px", () => {
  // Project tokens are commonly stored as rem strings ("1rem"). The
  // resolver must convert to px for the styling output, NOT pass the
  // numeric prefix straight through (parseFloat("1rem") === 1, wrong).
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { spacing: { "4": "1rem", "8": "2rem" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("p-4 gap-8");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.padding, "16px 16px 16px 16px");
    assert.equal(result!.base.gap, "32px");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: padding binds when all sides came from same spacing token", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { spacing: { "4": "16px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("p-4");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.deepEqual(result!.baseBindings.padding, { token: "4", collection: "spacing" });
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: padding does NOT bind when sides came from different tokens", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { spacing: { "2": "8px", "4": "16px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("px-4 py-2");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.baseBindings.padding, undefined);
    assert.ok(result!.warnings.some((w) => w.includes("different spacing tokens")));
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: padding does NOT bind when only some sides are set", () => {
  // px-4 alone leaves top/bottom at the default 0. Emitting a single
  // bindings.padding entry would tell Figma to bind all four sides to
  // the spacing token, which isn't what the source said. Stay literal
  // and surface a warning.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { spacing: { "4": "16px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("px-4");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.baseBindings.padding, undefined);
    assert.ok(result!.warnings.some((w) => w.includes("2/4 sides")));
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: gap binds to spacing token", () => {
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { spacing: { "3": "12px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("gap-3");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.gap, "12px");
    assert.deepEqual(result!.baseBindings.gap, { token: "3", collection: "spacing" });
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: shadow project token overrides bundled default", () => {
  // Symmetric to the existing radius-override test.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { boxShadow: { sm: "0 8px 16px rgba(0,0,0,0.2)" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("shadow-sm");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.shadow, "0 8px 16px rgba(0,0,0,0.2)");
    assert.deepEqual(result!.baseBindings.shadow, { token: "sm", collection: "shadows" });
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: text-{key} prefers project typography token over bundled default", () => {
  // text-base is bundled at 16px, but if the project defines a different
  // typography token of that name, that should win and bind.
  const dir = makeProject({
    "tailwind.config.js": `module.exports = { theme: { extend: { fontSize: { base: "15px" } } } };`,
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("text-base");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fontSize, "15px");
    assert.deepEqual(result!.baseBindings.fontSize, { token: "base", collection: "typography" });
  } finally {
    cleanup(dir);
  }
});

// --- cn()/clsx() conditional class pattern ---

test("parseCnCall: extracts base + variant entries from conditional cn() args", () => {
  const source = `
import { cn } from '@/lib/utils';
export const Button = ({ variant = 'primary', size = 'md' }) => (
  <button
    className={cn(
      'rounded-md font-medium',
      size === 'sm' && 'h-8 px-3',
      size === 'md' && 'h-10 px-4',
      variant === 'primary' && 'bg-blue-600 text-white',
      variant === 'ghost' && 'bg-transparent text-foreground',
      className
    )}
  />
);
`;
  const parsed = parseCnCall(source);
  assert.ok(parsed);
  assert.equal(parsed!.base, "rounded-md font-medium");
  assert.deepEqual(parsed!.variants.size, { sm: "h-8 px-3", md: "h-10 px-4" });
  assert.deepEqual(parsed!.variants.variant, { primary: "bg-blue-600 text-white", ghost: "bg-transparent text-foreground" });
});

test("parseCnCall: handles boolean shorthand `disabled && '...'`", () => {
  const source = `
import { cn } from '@/lib/utils';
const x = cn('base', disabled && 'opacity-50 cursor-not-allowed', !active && 'border-zinc-200');
`;
  const parsed = parseCnCall(source);
  assert.ok(parsed);
  assert.deepEqual(parsed!.variants.disabled, { true: "opacity-50 cursor-not-allowed" });
  assert.deepEqual(parsed!.variants.active, { false: "border-zinc-200" });
});

test("parseCnCall: ignores bare identifiers like className", () => {
  const source = `
import { cn } from '@/lib/utils';
const x = cn('base', className);
`;
  const parsed = parseCnCall(source);
  assert.ok(parsed);
  assert.equal(parsed!.base, "base");
  assert.deepEqual(parsed!.variants, {});
});

test("parseCnCall: skips the import line", () => {
  // The cn import shouldn't be mistaken for a call.
  const source = `import { cn } from '@/lib/utils';`;
  assert.equal(parseCnCall(source), null);
});

test("parseCnCall: returns null when neither cva nor cn pattern present", () => {
  const source = `const x = "just a string";`;
  assert.equal(parseCnCall(source), null);
});

test("parseCnCall: also matches clsx, classNames, twMerge, cx", () => {
  for (const name of ["clsx", "classNames", "twMerge", "cx"]) {
    const source = `import { ${name} } from 'lib';\nconst x = ${name}('base', size === 'sm' && 'h-8');`;
    const parsed = parseCnCall(source);
    assert.ok(parsed, `expected ${name} to parse`);
    assert.equal(parsed!.base, "base");
    assert.deepEqual(parsed!.variants.size, { sm: "h-8" });
  }
});

test("inspectComponent: resolves cn()-pattern component end-to-end", () => {
  // The crenel-style pattern: hand-rolled cn() with size/variant conditionals,
  // defaults read from prop destructure.
  const dir = makeProject({
    "src/components/ui/button.tsx": `
import { cn } from '@/lib/utils';
export const Button = ({ variant = 'primary', size = 'md', className }) => (
  <button
    className={cn(
      'inline-flex rounded-md font-medium',
      size === 'sm' && 'h-8 px-3 text-sm',
      size === 'md' && 'h-10 px-4 text-sm',
      size === 'lg' && 'h-11 px-5 text-base',
      variant === 'primary' && 'bg-blue-600 text-white',
      variant === 'ghost' && 'bg-transparent text-foreground',
      className
    )}
  />
);
`,
  });
  try {
    const result = inspectComponent(dir, "Button");
    assert.ok(result);
    // Base styling came from the unconditional first arg.
    assert.equal(result!.base.borderRadius, "6px");

    const sizeVariant = result!.variants.find((v) => v.name === "size");
    assert.ok(sizeVariant);
    assert.equal(sizeVariant!.defaultValue, "md");
    assert.equal(sizeVariant!.values.sm.fontSize, "14px");
    assert.equal(sizeVariant!.values.md.fontSize, "14px");
    assert.equal(sizeVariant!.values.lg.fontSize, "16px");
    assert.equal(sizeVariant!.values.sm.padding, "0px 12px 0px 12px");

    const variantVariant = result!.variants.find((v) => v.name === "variant");
    assert.ok(variantVariant);
    assert.equal(variantVariant!.defaultValue, "primary");
    assert.equal(variantVariant!.values.primary.fill, "#2563eb");
    assert.equal(variantVariant!.values.primary.text, "#ffffff");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: bundled fontSize default still works when no token defined", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("text-lg");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fontSize, "18px");
    assert.equal(result!.baseBindings.fontSize, undefined);
  } finally {
    cleanup(dir);
  }
});

// --- Catalyst-style style object map ---

test("inspectComponent: Catalyst-style `const styles = { base, solid, colors }` map", () => {
  // Stripped-down Catalyst Button shape: a `styles` constant declares base
  // and per-color class arrays. Each color sets CSS custom properties via
  // arbitrary-property setters; the button uses them via `bg-(--btn-bg)` /
  // `bg-(--btn-border)` references. The resolver should: (1) detect the
  // styles map, (2) synthesize a `color` variant axis, (3) collect the CSS
  // var setters, (4) resolve the `before:bg-` as the visible fill and the
  // direct `bg-` as the optical stroke.
  const dir = makeProject({
    "components/catalyst/button.tsx": `
import clsx from 'clsx';
const styles = {
  base: ['inline-flex rounded-lg border'],
  solid: [
    'border-transparent bg-(--btn-border)',
    'before:absolute before:inset-0 before:bg-(--btn-bg)',
  ],
  colors: {
    red: [
      'text-white [--btn-bg:var(--color-red-600)] [--btn-border:var(--color-red-700)]',
    ],
    blue: [
      'text-white [--btn-bg:var(--color-blue-600)] [--btn-border:var(--color-blue-700)]',
    ],
  },
};
export const Button = ({ color = 'red' }) => (
  <button className={clsx(styles.base, styles.solid, styles.colors[color])} />
);
`,
  });
  try {
    const result = inspectComponent(dir, "button");
    assert.ok(result);

    const colorVariant = result!.variants.find((v) => v.name === "color");
    assert.ok(colorVariant, "expected a `color` variant axis");
    assert.deepEqual(Object.keys(colorVariant!.values).sort(), ["blue", "red"]);
    assert.equal(colorVariant!.defaultValue, "red");

    // Red: fill = red-600 (from before:bg-(--btn-bg)),
    //      stroke = red-700 (from button bg-(--btn-border)).
    const red = colorVariant!.values.red;
    assert.equal(red.fill, "#dc2626");
    assert.equal(red.borderColor, "#b91c1c");
    assert.equal(red.text, "#ffffff");
    assert.equal(red.borderRadius, "8px");

    const blue = colorVariant!.values.blue;
    assert.equal(blue.fill, "#2563eb");
    assert.equal(blue.borderColor, "#1d4ed8");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: CSS variable setter alpha modifier `[--name:value]/N`", () => {
  // Catalyst writes opacity into setters as `[--btn-border:var(--color-red-700)]/90`.
  // The slash-suffix is the alpha as a percentage; the resolved color
  // should carry an 8-digit hex (with the alpha byte appended).
  const dir = makeProject({
    "components/catalyst/x.tsx": `
const styles = {
  base: ['rounded-md'],
  solid: ['bg-(--btn-bg)'],
  colors: { red: ['[--btn-bg:var(--color-red-700)]/90'] },
};
export const X = ({ color = 'red' }) => (
  <div className={\`\${styles.base.join(' ')} \${styles.solid.join(' ')} \${styles.colors[color].join(' ')}\`} />
);
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    const colorVariant = result!.variants.find((v) => v.name === "color");
    assert.ok(colorVariant);
    // red-700 = #b91c1c; 90% alpha = 0xe6.
    assert.equal(colorVariant!.values.red.fill, "#b91c1ce6");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: bg-(--var) reference resolves through CSS variable setter", () => {
  // Smaller end-to-end check: a single class string with both a setter
  // and a reference. No styles map, no variants.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("[--my-bg:var(--color-emerald-600)] bg-(--my-bg)");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#059669");
  } finally {
    cleanup(dir);
  }
});

test("inspectComponent: bg-[var(--name)] arbitrary-value form also resolves", () => {
  // Tailwind 3 syntax for the same idea — should be handled identically.
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("[--my-bg:#ff00ff] bg-[var(--my-bg)]");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#ff00ff");
  } finally {
    cleanup(dir);
  }
});

test("parseStyleObjectMap: extracts base, solid, outline, plain, colors arrays", () => {
  const source = `
const styles = {
  base: ['a', 'b'],
  solid: ['c'],
  outline: ['d'],
  plain: ['e'],
  colors: {
    red: ['f'],
    blue: ['g', 'h'],
  },
};
`;
  const map = parseStyleObjectMap(source);
  assert.ok(map);
  assert.deepEqual(map!.base, ["a", "b"]);
  assert.deepEqual(map!.solid, ["c"]);
  assert.deepEqual(map!.outline, ["d"]);
  assert.deepEqual(map!.plain, ["e"]);
  assert.deepEqual(map!.colors, { red: ["f"], blue: ["g", "h"] });
});

test("parseStyleObjectMap: returns null when no styles declaration found", () => {
  assert.equal(parseStyleObjectMap("export const Button = () => null;"), null);
});

test("parseStyleMapAsCva: each color value's class string includes base + solid + per-color", () => {
  // Each variant value's class string carries the FULL styling rather than
  // splitting base out separately — the per-color CSS variable setters need
  // to be in the same string as the references in base/solid for the
  // resolver's per-string CSS-variable map to wire them together.
  const source = `
const styles = {
  base: ['rounded'],
  solid: ['bg-blue-500'],
  colors: { red: ['text-red-100'], blue: ['text-blue-100'] },
};
`;
  const cva = parseStyleMapAsCva(source);
  assert.ok(cva);
  assert.equal(cva!.base, "");
  assert.deepEqual(Object.keys(cva!.variants.color).sort(), ["blue", "red"]);
  assert.equal(cva!.variants.color.red, "rounded bg-blue-500 text-red-100");
  assert.equal(cva!.variants.color.blue, "rounded bg-blue-500 text-blue-100");
});

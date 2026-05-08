import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { inspectComponent, findComponentFile, parseCvaCall } from "../inspect.js";

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

test("findComponentFile: skips node_modules and dist", () => {
  const dir = makeProject({
    "node_modules/button.tsx": "//",
    "dist/button.tsx": "//",
    "src/components/button.tsx": "export const Button = () => null;",
  });
  try {
    const found = findComponentFile(dir, "button");
    assert.ok(found);
    assert.ok(found!.includes("src/components"));
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
    assert.ok(result!.warnings.some((w) => w.includes("does not use cva")));
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

test("inspectComponent: strips responsive/state prefixes from classes", () => {
  const dir = makeProject({
    "src/components/x.tsx": `
import { cva } from "cva";
const x = cva("md:bg-blue-500 hover:text-white");
`,
  });
  try {
    const result = inspectComponent(dir, "x");
    assert.ok(result);
    assert.equal(result!.base.fill, "#3b82f6");
    assert.equal(result!.base.text, "#ffffff");
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

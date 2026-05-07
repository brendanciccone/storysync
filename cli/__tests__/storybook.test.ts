import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCategoryFromId,
  parseProps,
  parsePropsBlock,
  parseArgTable,
  parseStorySnippets,
} from "../storybook.js";

test("deriveCategoryFromId: single-word category", () => {
  assert.equal(deriveCategoryFromId("ui-button", "Button"), "UI");
  assert.equal(deriveCategoryFromId("catalyst-badge", "Badge"), "Catalyst");
  assert.equal(deriveCategoryFromId("tailwind-emptystate", "EmptyState"), "Tailwind");
});

test("deriveCategoryFromId: PascalCase name kebab-cases correctly", () => {
  assert.equal(deriveCategoryFromId("ui-iconbutton", "IconButton"), "UI");
  assert.equal(deriveCategoryFromId("ui-delta-pill", "DeltaPill"), "UI");
});

test("deriveCategoryFromId: multi-word category round-trips", () => {
  assert.equal(deriveCategoryFromId("data-display-card", "Card"), "Data Display");
  assert.equal(deriveCategoryFromId("forms-inputs-text-field", "TextField"), "Forms Inputs");
});

test("deriveCategoryFromId: strips story suffix after --", () => {
  assert.equal(deriveCategoryFromId("ui-button--primary", "Button"), "UI");
});

test("deriveCategoryFromId: name with spaces", () => {
  assert.equal(deriveCategoryFromId("ui-card-header", "Card Header"), "UI");
});

test("deriveCategoryFromId: no category prefix returns undefined", () => {
  assert.equal(deriveCategoryFromId("button", "Button"), undefined);
});

test("deriveCategoryFromId: name doesn't match ID returns undefined", () => {
  assert.equal(deriveCategoryFromId("ui-button", "Card"), undefined);
});

// --- parsePropsBlock: TypeScript type defs in code fences ---

test("parsePropsBlock: official addon-mcp format with JSDoc comments", () => {
  const block = `export type Props = {
  /**
    The button variant
  */
  variant?: "primary" | "secondary" = "primary";
  /**
    Whether the button is disabled
  */
  disabled?: boolean = false;
}`;
  const props = parsePropsBlock(block);
  assert.equal(props.length, 2);
  assert.equal(props[0].name, "variant");
  assert.equal(props[0].type.name, "union");
  assert.equal(props[0].type.raw, '"primary" | "secondary"');
  assert.equal(props[0].defaultValue, "primary");
  assert.equal(props[0].required, false);
  assert.equal(props[1].name, "disabled");
  assert.equal(props[1].type.name, "boolean");
  assert.equal(props[1].defaultValue, "false");
});

test("parsePropsBlock: required prop (no `?`)", () => {
  const block = `type Props = {
  label: string;
}`;
  const props = parsePropsBlock(block);
  assert.equal(props.length, 1);
  assert.equal(props[0].required, true);
});

test("parsePropsBlock: interface body", () => {
  const block = `export interface ButtonProps {
  variant?: "a" | "b";
  size?: "sm" | "md";
}`;
  const props = parsePropsBlock(block);
  assert.equal(props.length, 2);
  assert.equal(props[0].name, "variant");
});

test("parsePropsBlock: returns [] for non-type code blocks", () => {
  assert.equal(parsePropsBlock(`<Button variant="primary" />`).length, 0);
  assert.equal(parsePropsBlock(`import { Button } from './Button';`).length, 0);
});

// --- parseProps: end-to-end on realistic addon-mcp markdown ---

test("parseProps: official addon-mcp markdown picks props out of code fence", () => {
  const text = `# Button

ID: button

## Stories

### Primary

Story ID: button--primary

\`\`\`
import { Button } from '@/Button';

<Button variant="primary">Click</Button>
\`\`\`

## Props

\`\`\`
export type Props = {
  variant?: "primary" | "secondary" = "primary";
  size?: "sm" | "md" | "lg" = "md";
  disabled?: boolean = false;
}
\`\`\`
`;
  const props = parseProps(text, "Button");
  assert.equal(props.length, 3);
  assert.equal(props[0].name, "variant");
  assert.equal(props[1].name, "size");
  assert.equal(props[2].name, "disabled");
});

test("parseProps: falls back to story snippets when no Props section emitted", () => {
  // This is what the official addon-mcp produces when only argTypes are
  // defined in stories — no `## Props` section, just snippets.
  const text = `# Button

ID: button

## Stories

### Primary

Story ID: button--primary

\`\`\`
<Button variant="primary" size="md">Click</Button>
\`\`\`

### Secondary

Story ID: button--secondary

\`\`\`
<Button variant="secondary" size="lg">Click</Button>
\`\`\`

### Small

Story ID: button--small

\`\`\`
<Button variant="primary" size="sm" disabled>Click</Button>
\`\`\`
`;
  const props = parseProps(text, "Button");
  const variant = props.find((p) => p.name === "variant");
  const size = props.find((p) => p.name === "size");
  const disabled = props.find((p) => p.name === "disabled");

  assert.ok(variant, "expected variant prop from snippets");
  assert.deepEqual(variant!.control?.options, ["primary", "secondary"]);
  assert.ok(size, "expected size prop from snippets");
  assert.deepEqual(size!.control?.options, ["md", "lg", "sm"]);
  assert.ok(disabled, "expected disabled prop from snippets");
  assert.equal(disabled!.type.name, "boolean");
});

// --- parseArgTable: defensive parser for third-party MCP servers ---

test("parseArgTable: basic Name/Type/Default table", () => {
  const text = `| Name | Type | Default |
| ---- | ---- | ------- |
| variant | "primary" \\| "secondary" | "primary" |
| size | "sm" \\| "md" | "md" |
| disabled | boolean | false |`;
  const props = parseArgTable(text);
  assert.equal(props.length, 3);
  assert.equal(props[0].name, "variant");
  assert.equal(props[0].type.name, "union");
  assert.equal(props[0].type.raw, '"primary" | "secondary"');
  assert.equal(props[0].defaultValue, "primary");
  assert.equal(props[2].name, "disabled");
  assert.equal(props[2].type.name, "boolean");
  assert.equal(props[2].control?.type, "boolean");
});

test("parseArgTable: table without leading/trailing pipes", () => {
  const text = `Name | Type | Default
---- | ---- | -------
variant | "a" \\| "b" | "a"`;
  const props = parseArgTable(text);
  assert.equal(props.length, 1);
  assert.equal(props[0].name, "variant");
});

test("parseArgTable: Control + Options columns extract options", () => {
  const text = `| Name | Control | Options | Default |
| ---- | ------- | ------- | ------- |
| variant | select | primary, secondary, tertiary | primary |
| size | radio | sm, md, lg | md |`;
  const props = parseArgTable(text);
  assert.equal(props.length, 2);
  assert.equal(props[0].name, "variant");
  assert.deepEqual(props[0].control?.options, ["primary", "secondary", "tertiary"]);
  assert.equal(props[0].defaultValue, "primary");
  assert.equal(props[1].name, "size");
  assert.deepEqual(props[1].control?.options, ["sm", "md", "lg"]);
});

test("parseArgTable: empty cells don't shift column alignment", () => {
  // The previous parser used filter(Boolean), which dropped empty cells
  // from data rows and shifted later columns into the wrong slot.
  const text = `| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| variant | "a" \\| "b" |  | The variant |
| size | "sm" \\| "md" | "md" | The size |`;
  const props = parseArgTable(text);
  assert.equal(props.length, 2);
  assert.equal(props[0].name, "variant");
  assert.equal(props[0].defaultValue, undefined);
  assert.equal(props[1].name, "size");
  assert.equal(props[1].defaultValue, "md");
});

test("parseArgTable: bold property names are stripped", () => {
  const text = `| **Name** | **Type** | **Default** |
| -------- | -------- | ----------- |
| **variant** | "a" \\| "b" | "a" |`;
  const props = parseArgTable(text);
  assert.equal(props.length, 1);
  assert.equal(props[0].name, "variant");
});

test("parseArgTable: dash placeholder treated as missing default", () => {
  const text = `| Name | Type | Default |
| ---- | ---- | ------- |
| variant | "a" \\| "b" | - |`;
  const props = parseArgTable(text);
  assert.equal(props[0].defaultValue, undefined);
});

test("parseArgTable: stops at end of table", () => {
  const text = `| Name | Type | Default |
| ---- | ---- | ------- |
| variant | "a" \\| "b" | "a" |

Some other text after the table.

| OtherTable | Foo |
| ---------- | --- |
| ignored | bar |`;
  const props = parseArgTable(text);
  assert.equal(props.length, 1);
  assert.equal(props[0].name, "variant");
});

test("parseArgTable: returns [] when no recognizable table", () => {
  assert.equal(parseArgTable("just some prose").length, 0);
  assert.equal(parseArgTable("| a | b |\n| - | - |\n| 1 | 2 |").length, 0);
});

// --- parseStorySnippets: JSX-based fallback for argTypes-only components ---

test("parseStorySnippets: extracts variant values across multiple snippets", () => {
  const text = `\`\`\`
<Button variant="primary" size="md">Hello</Button>
\`\`\`

\`\`\`
<Button variant="secondary" size="lg">World</Button>
\`\`\``;
  const props = parseStorySnippets(text, "Button");
  const variant = props.find((p) => p.name === "variant");
  assert.ok(variant);
  assert.deepEqual(variant!.control?.options, ["primary", "secondary"]);
  assert.equal(variant!.defaultValue, "primary");
});

test("parseStorySnippets: boolean shorthand attribute", () => {
  const text = `<Button disabled>Click</Button>`;
  const props = parseStorySnippets(text, "Button");
  const disabled = props.find((p) => p.name === "disabled");
  assert.ok(disabled);
  assert.equal(disabled!.type.name, "boolean");
  assert.equal(disabled!.defaultValue, "true");
});

test("parseStorySnippets: explicit boolean expressions", () => {
  const text = `<Button disabled={true}>A</Button><Button disabled={false}>B</Button>`;
  const props = parseStorySnippets(text, "Button");
  const disabled = props.find((p) => p.name === "disabled");
  assert.ok(disabled);
  assert.equal(disabled!.type.name, "boolean");
});

test("parseStorySnippets: skips single-value string props (insufficient signal)", () => {
  // One occurrence of one value isn't enough to call something a variant.
  const text = `<Button label="Click">x</Button>`;
  const props = parseStorySnippets(text, "Button");
  assert.equal(props.find((p) => p.name === "label"), undefined);
});

test("parseStorySnippets: ignores spread and unknown expressions", () => {
  const text = `<Button {...args} onClick={handler}>Click</Button>
<Button variant="primary" onClick={handler2}>x</Button>
<Button variant="secondary" onClick={handler3}>y</Button>`;
  const props = parseStorySnippets(text, "Button");
  // onClick has unknown values only — should be skipped.
  assert.equal(props.find((p) => p.name === "onClick"), undefined);
  // variant should still be extracted.
  const variant = props.find((p) => p.name === "variant");
  assert.ok(variant);
  assert.deepEqual(variant!.control?.options, ["primary", "secondary"]);
});

test("parseStorySnippets: multi-line JSX attributes", () => {
  const text = `<Button
  variant="primary"
  size="lg"
  disabled
>
  Click
</Button>
<Button
  variant="secondary"
  size="sm"
>
  Other
</Button>`;
  const props = parseStorySnippets(text, "Button");
  const variant = props.find((p) => p.name === "variant");
  assert.ok(variant);
  assert.deepEqual(variant!.control?.options, ["primary", "secondary"]);
});

test("parseStorySnippets: doesn't match other components", () => {
  const text = `<IconButton variant="x">a</IconButton>
<IconButton variant="y">b</IconButton>`;
  // We're asking for "Button" — IconButton should not match.
  const props = parseStorySnippets(text, "Button");
  assert.equal(props.length, 0);
});

test("parseStorySnippets: returns [] without component name", () => {
  const text = `<Button variant="a">x</Button>`;
  assert.equal(parseStorySnippets(text).length, 0);
});

test("parseStorySnippets: string in expression form ({\"primary\"})", () => {
  const text = `<Button variant={"primary"}>x</Button>
<Button variant={"secondary"}>y</Button>`;
  const props = parseStorySnippets(text, "Button");
  const variant = props.find((p) => p.name === "variant");
  assert.ok(variant);
  assert.deepEqual(variant!.control?.options, ["primary", "secondary"]);
});

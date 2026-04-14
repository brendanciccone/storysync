import { describe, test, expect } from "vitest";
import { parseComponentList, parseProps, parseStories } from "../cli/parsers.js";

// --- parseComponentList ---

describe("parseComponentList", () => {
  test("parses standard markdown list", () => {
    const text = `- **Button** (id: \`button\`) - A clickable button
  - Primary (id: \`button--primary\`)
  - Secondary (id: \`button--secondary\`)
- **Input** (id: \`input\`) - Text input field`;

    const entries = parseComponentList(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: "Button",
      id: "button",
      storyIds: ["button--primary", "button--secondary"],
    });
    expect(entries[1]).toEqual({
      name: "Input",
      id: "input",
      storyIds: [],
    });
  });

  test("handles single-quoted IDs", () => {
    const text = `- **Card** (id: 'card') - A card component`;
    const entries = parseComponentList(text);
    expect(entries[0].id).toBe("card");
  });

  test("handles double-quoted IDs", () => {
    const text = `- **Card** (id: "card") - A card component`;
    const entries = parseComponentList(text);
    expect(entries[0].id).toBe("card");
  });

  test("handles entries without bold formatting", () => {
    const text = `- Button (id: \`button\`) - A button`;
    const entries = parseComponentList(text);
    expect(entries[0].name).toBe("Button");
  });

  test("handles asterisk bullet points", () => {
    const text = `* **Button** (id: \`button\`) - A button`;
    const entries = parseComponentList(text);
    expect(entries[0].name).toBe("Button");
  });

  test("returns empty array for non-matching text", () => {
    const entries = parseComponentList("No components here");
    expect(entries).toHaveLength(0);
  });

  test("handles empty input", () => {
    const entries = parseComponentList("");
    expect(entries).toHaveLength(0);
  });
});

// --- parseProps ---

describe("parseProps", () => {
  test("parses props from fenced code block", () => {
    const text = `# Button

\`\`\`typescript
export type Props = {
  variant: "primary" | "secondary";
  disabled?: boolean;
};
\`\`\``;

    const props = parseProps(text);
    expect(props).toHaveLength(2);
    expect(props[0]).toEqual({
      name: "variant",
      type: { name: "union", raw: '"primary" | "secondary"' },
      defaultValue: undefined,
      required: true,
    });
    expect(props[1]).toEqual({
      name: "disabled",
      type: { name: "boolean" },
      defaultValue: undefined,
      required: false,
    });
  });

  test("parses props with default values", () => {
    const text = `\`\`\`ts
export type Props = {
  size: "sm" | "md" | "lg" = "md";
};
\`\`\``;

    const props = parseProps(text);
    expect(props[0].defaultValue).toBe("md");
    expect(props[0].type).toEqual({ name: "union", raw: '"sm" | "md" | "lg"' });
  });

  test("handles tsx code fence language", () => {
    const text = `\`\`\`tsx
export type ButtonProps = {
  loading?: boolean;
};
\`\`\``;

    const props = parseProps(text);
    expect(props).toHaveLength(1);
    expect(props[0].name).toBe("loading");
  });

  test("handles unlabeled code fence", () => {
    const text = `\`\`\`
export type Props = {
  active?: boolean;
};
\`\`\``;

    const props = parseProps(text);
    expect(props).toHaveLength(1);
  });

  test("falls back to inline type definition", () => {
    const text = `The component has the following props:
export type Props = { disabled?: boolean; }`;

    const props = parseProps(text);
    expect(props).toHaveLength(1);
    expect(props[0].name).toBe("disabled");
  });

  test("skips comment lines inside type definition", () => {
    const text = `\`\`\`typescript
export type Props = {
  // Whether the button is disabled
  disabled?: boolean;
  /** The button variant */
  variant: "primary" | "secondary";
};
\`\`\``;

    const props = parseProps(text);
    expect(props).toHaveLength(2);
  });

  test("handles simple non-union types", () => {
    const text = `\`\`\`typescript
export type Props = {
  label: string;
  count: number;
  onClick: () => void;
};
\`\`\``;

    const props = parseProps(text);
    expect(props).toHaveLength(3);
    expect(props[0].type).toEqual({ name: "string" });
    expect(props[1].type).toEqual({ name: "number" });
  });

  test("returns empty array when no type definition found", () => {
    const text = `# Button\n\nThis component has no documented props.`;
    const props = parseProps(text);
    expect(props).toHaveLength(0);
  });

  test("parses multiple code blocks and merges props", () => {
    const text = `\`\`\`typescript
export type Props = {
  disabled?: boolean;
};
\`\`\`

\`\`\`typescript
export type OtherProps = {
  loading?: boolean;
};
\`\`\``;

    const props = parseProps(text);
    expect(props).toHaveLength(2);
  });
});

// --- parseStories ---

describe("parseStories", () => {
  test("extracts story IDs from text", () => {
    const text = `## Stories
- Primary (id: \`button--primary\`)
- Secondary (id: \`button--secondary\`)`;

    const stories = parseStories("Button", text);
    expect(stories).toHaveLength(2);
    expect(stories[0]).toEqual({ id: "button--primary", name: "Primary" });
    expect(stories[1]).toEqual({ id: "button--secondary", name: "Secondary" });
  });

  test("handles storyId format", () => {
    const text = `Story (storyId: "button--large")`;
    const stories = parseStories("Button", text);
    expect(stories).toHaveLength(1);
    expect(stories[0].id).toBe("button--large");
  });

  test("deduplicates story IDs", () => {
    const text = `id: \`button--primary\`
id: \`button--primary\``;
    const stories = parseStories("Button", text);
    expect(stories).toHaveLength(1);
  });

  test("skips IDs without -- separator", () => {
    const text = `id: \`button\``;
    const stories = parseStories("Button", text);
    // Falls back to default
    expect(stories).toHaveLength(1);
    expect(stories[0].id).toBe("button--default");
  });

  test("returns default story when none found", () => {
    const text = "No stories here";
    const stories = parseStories("Button", text);
    expect(stories).toEqual([{ id: "button--default", name: "Default" }]);
  });

  test("converts slug to title case name", () => {
    const text = `id: \`button--with-icon\``;
    const stories = parseStories("Button", text);
    expect(stories[0].name).toBe("With Icon");
  });
});

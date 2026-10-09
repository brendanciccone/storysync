// Tokens for package B's tests.

// The light theme of the shadcn/ui registry's app/globals.css (MIT), as
// `storysync tokens --json` reads it: several tokens share most values.
export const SHADCN_TOKENS = {
  collections: [
    {
      category: "colors" as const,
      tokens: [
        ["card", "#ffffff"], ["card/foreground", "#0a0a0a"], ["popover", "#ffffff"], ["popover/foreground", "#0a0a0a"],
        ["primary", "#171717"], ["primary/foreground", "#fafafa"], ["secondary", "#f5f5f5"], ["secondary/foreground", "#171717"],
        ["muted", "#f5f5f5"], ["muted/foreground", "#737373"], ["accent", "#f5f5f5"], ["accent/foreground", "#171717"],
        ["destructive", "#df2225"], ["border", "#e5e5e5"], ["input", "#e5e5e5"], ["ring", "#a1a1a1"],
        ["sidebar/primary", "#171717"], ["sidebar/primary/foreground", "#fafafa"], ["sidebar/foreground", "#0a0a0a"],
        ["background", "#ffffff"], ["foreground", "#0a0a0a"],
      ].map(([name, hex]) => ({ name, value: hex, hex })),
    },
    {
      category: "radius" as const,
      tokens: [["DEFAULT", 10], ["sm", 6], ["md", 8], ["lg", 10], ["xl", 14]].map(([name, px]) => ({ name: String(name), value: `${px}px`, px: Number(px) })),
    },
  ],
};

<img src="assets/logo.png" alt="Storysync logo" width="88" height="88">

# Storysync

[![CI](https://github.com/brendanciccone/storysync/actions/workflows/ci.yml/badge.svg)](https://github.com/brendanciccone/storysync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/storysync)](https://www.npmjs.com/package/storysync)

Sync your design system from code to Figma, and diff Figma back against code, using Storybook MCP and Figma MCP.

![Claude Code running /storysync-push and reporting 100% fidelity (174 of 174 properties), beside the pushed Button component set in Figma and the Button story in Storybook](assets/screenshot.webp)

**Start here:** [What it does](#what-it-does) · [Install](#install) · [Your first push](#your-first-push) · [What a push costs](#what-a-push-costs) · [Check the result](#check-the-result) · [Find drift](#find-drift) · [What Figma can't do](#what-figma-cant-do)

**Reference:** [docs/reference.md](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md) has every command and flag, how each step works, tokens, the GitHub Action and troubleshooting.

## What it does

Storysync reads design tokens from your code (a Tailwind config, CSS custom properties or theme files) and components from [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview). Your AI client then uses [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) to create matching Figma variables and component sets.

Component styling is measured, not guessed:

1. `storysync snap` renders every variant of every component in a headless browser and records the computed styles of each element that draws: fills, spacing, radii, type, icons and pictures.
2. `storysync figma code` turns those measurements into the Figma calls your AI client sends, unchanged.
3. `storysync verify` reads Figma back and scores it against the measurements, element by element.

There are three workflows: **push** (code to Figma), **verify** (score what landed against what rendered) and **diff** (find drift in either direction). Storysync never writes your code. See [Non-goals](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#non-goals).

| Use it from | What it does |
|---|---|
| **Claude Code**, **Cursor** or **Codex** | A skill file runs the CLI commands, sends the Figma calls through `use_figma`, and scores the result with `verify`. It can also audit Figma against code. |
| **The CLI** | Extract tokens, map components, measure rendered styles, write a push's Figma calls, score a push, or diff Figma against code. |
| **GitHub Action** | Catch token and component drift in CI. |

Why a skill file? Writing to Figma needs Figma's `use_figma` tool, which works only inside [supported MCP clients](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) such as Claude Code, Cursor and Codex. So the CLI does the extracting, the measuring and the writing of every component call, and the skill tells your AI client to send those calls and run the commands around them. The skill writes the token variables itself, from `tokens --json`. Storysync needs no Anthropic API key and makes no LLM calls of its own.

## Before you start

**For components:**

- Storybook 10.1 or later with a Vite-based framework: `@storybook/react-vite`, `@storybook/nextjs-vite` or `@storybook/sveltekit`. Storybook 9 supports token extraction only.
- `@storybook/addon-mcp`, which serves MCP at `/mcp`. `storysync init` sets it up.
- The Storybook dev server (`storybook dev`), not a static build.
- Node.js 18 or later, or 20 or later for `snap`.
- A Chromium-based browser, for `snap` only.

**For writing to Figma:**

- A Full seat on a paid plan. Dev seats are read-only ([Figma's docs](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas)).
- A supported MCP client, which signs you in to Figma.
- Figma limits MCP tool calls by plan and seat. See [Figma's rate limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/).

**For tokens:** nothing else. Token extraction reads only local files, so it needs no Storybook, MCP connection or sign-in.

## Install

```bash
npm install -g storysync                # or: pnpm add -g storysync

cd your-project
npx storysync init                      # set up @storybook/addon-mcp if needed
npx storysync setup --client claude     # or: --client cursor, --client codex
```

`setup` writes the skill file, plus slash commands for Claude Code, and prints the MCP setup commands you still need to run.

To try Storysync without a project of your own, use [`examples/storybook-vite`](https://github.com/brendanciccone/storysync/tree/main/examples/storybook-vite). It's a small Storybook with one component that measures cleanly and one whose story is broken on purpose, so you can see the warning.

## Your first push

Connect your client to both MCP servers, start Storybook, and ask for a push.

### Claude Code

```bash
claude mcp add --transport http storybook http://localhost:6006/mcp
claude plugin install figma@claude-plugins-official
```

Start Storybook, open Claude Code, and run `/storysync-push <figma-file-key>`. The file key is the part of a Figma URL between `/design/` and the next `/`.

### Cursor

`storysync setup --client cursor` writes the rule to `.cursor/rules/storysync.mdc`. Add Storybook MCP to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "storybook": { "url": "http://localhost:6006/mcp" }
  }
}
```

In Cursor's Agent chat, type `/add-plugin figma` and sign in to Figma. Then start Storybook and ask the agent to push.

Cursor's terminal sandbox blocks `localhost`, so the agent asks to run `storysync list`, `map`, `inspect` and `snap` outside it, and `figma upload`, which posts pictures to Figma. Approve them: they need to reach Storybook or Figma.

### Codex

`storysync setup --client codex` writes the skill to `.agents/skills/storysync/SKILL.md`. Then add the MCP servers:

```bash
codex mcp add storybook --url http://localhost:6006/mcp
codex mcp add figma --url https://mcp.figma.com/mcp      # signs you in to Figma
```

With Storybook running, ask Codex to push. In the CLI, you can type `$storysync` to name the skill. See [Codex details](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#codex-details) for the sandbox and timeouts.

### What to say

These work in every client:

| Goal | Say |
|---|---|
| Code to Figma | "Push my Storybook to Figma (file key `<key>`)" |
| Audit drift | "Diff Figma against code (file key `<key>`)" or "Check if Figma is in sync" |
| Score the last push | "Verify the Figma file against the measured styles" |

### What happens during a push

The skill walks your agent through these steps. It stops and asks you whenever a choice is yours.

1. **Tokens.** `storysync tokens --json` reads your tokens, and `storysync figma tokens` writes a call per collection that the agent sends to create or update its Figma variables. A dark theme becomes a Dark mode beside Light.
2. **Pick components.** `storysync list` counts them. With more than about 20, the agent asks which to push.
3. **Measure.** `storysync snap --variants all` renders every combination of every component's variant props. It runs in the background, since it can take minutes.
4. **Ask.** The agent asks you about anything the measurement can't settle on its own: a component with more combinations than the cap, an overlay snap couldn't open, or props that measured the same in every variant.
5. **Write the calls.** `storysync figma code` writes every Figma call as a file and prints an estimate of what the push will cost. The agent shows you the estimate and waits for your go-ahead. Where a translucent color such as `bg-destructive/10` binds to a variable, the first call adds one that carries its opacity, `destructive 10%`, so it stays translucent when a designer switches a frame to Dark.
6. **Send.** The agent sends each call to `use_figma` unchanged and saves each response unchanged.
7. **Score.** `storysync verify --plan` reads the responses and scores Figma against the measurement. The agent reports the score, what differs, and what it couldn't score.

The Figma file mirrors Storybook's sidebar: a page per category, and a component set per component, named by the last segment of its title.

## What a push costs

A push isn't lightweight. Your AI client sends every Figma call through its own context: each build call carries up to 45,000 characters of code, and each read call returns up to 20kb. That adds up in tokens.

**Rule of thumb:** plan on roughly 100k tokens per component, plus about 100k per push for setup and verification. Simple components use less. Components with big variant grids use 2 to 3 times more.

| Components | Plan on about |
|---|---|
| 10 | 1.1M tokens |
| 30 | 3.1M tokens |
| 60 | 6.1M tokens, split across sessions |

These numbers are calibrated from live pushes. Push 4, for example, built 5 components with 100 variants and 872 elements in 22 calls, for about 570k agent tokens.

**The estimate for your push.** `storysync figma code` prints an estimate for the calls it just wrote: how many calls, the characters the agent must send and read back, and a token range. The low end puts each character the calls carry at about 0.8 tokens, plus 100k for the push and 10k per component; the high end allows for a repair round and questions. The skills show you this estimate and ask before sending anything. `--json` puts it in `estimate`.

To spend less, push fewer components at a time with `--components`, in separate sessions.

Writing to the canvas is free during Figma's beta. [Figma's guide to its MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server) says it will become a usage-based paid feature.

## Check the result

The push ends with `storysync verify`, which scores what Figma holds against what snap measured:

```text
Fidelity: 99.8% of elements (29 of 30 verified), 99.7% of properties (389/390)
  worst: Forms/Button 99.8% of elements
  missing 0 · drifted 1 · extra 0 · designer layers 0 · not measured 0
  coverage 92.9%: not scored: line-height: normal, which each font's metrics set on Forms/Button › #text; ...
  ~ Forms/Button variant=primary, size=sm, disabled=false › #text: color measured #ffffff, Figma #ff00ff (node 1:2)
14 verified, 1 drifted, 0 missing from Figma, across 15 variants
```

- **Element fidelity** is the headline. Each element snap measured scores the share of its properties that Figma matches.
- Each line under it names one difference: component, variant, element key and Figma node id.
- **Coverage** lists what Figma can't represent or verify can't score. It is listed, never counted as a match.

The comparison is numeric, not visual, so it's deterministic and free. See [How verify scores](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#how-verify-scores) for the details.

**Test the score once on your own file.** A score is only as good as the readback behind it:

1. After a push, change one element inside a variant in Figma by hand: recolor a button's label or an icon, change a title's text, hide a layer, or delete one.
2. Have the agent send the push's read calls again, and run `verify --plan`. It should report exactly that element, by its key and node id, and nothing else.
3. Edit one value in a saved response under `.storysync/figma/results/` and run `verify --plan` again. That entry, and only that one, should fail its checksum.

Don't test it by moving a layer that sits in auto layout. To move, it has to leave the flow, so the layers after it move up and the frame around it shrinks, and `verify` reports those too, as Figma now has them. The acceptance suite runs both tests against the example project, and the test suite runs each edit on five shadcn components, then sends the build calls again and checks that everything verifies.

## Find drift

Ask your agent to diff Figma against code, or run `/storysync-diff <figma-file-key>` in Claude Code. The audit reads Figma's variables and component sets and compares them with `storysync tokens` and `storysync map`:

```text
+ missing from Figma     in code, not in Figma
- missing from code      in Figma, not in code
~ value mismatch         both exist, values differ
```

It compares token values and each component's variant properties. It needs `use_figma` to return what its code returns, which supported clients do. Asked whether the sets still look like the code, it can also score them as `verify` does, reading Figma and changing nothing.

The CLI's own [`storysync diff`](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#storysync-diff) does the same comparison, given a Figma MCP endpoint it can reach without signing in. To catch drift in CI, use the [GitHub Action](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#github-action).

## Write stories that measure well

snap measures what your stories render, so a few habits help:

- **Pass args through.** snap sets each variant's values through Storybook's `?args=` URL. A story that hardcodes props, uses a custom `render` that ignores its args, or has a decorator that drops them renders its default for every variant. Plain CSF3 args-driven stories are the reliable shape.
- **Mark the component's root.** snap measures the first element carrying the component's own `data-slot` (`switch` for `Switch`), as shadcn/ui puts on every component's root. Any project can point snap at a root the same way.
- **Give variants content that fits.** An icon-size button with a text label spills out of its square. snap picks a story whose own args set those values and give them content of their own, such as shadcn/ui Button's Icon story, or you can name one with `--stories`.
- **Let overlays open.** snap opens a Dialog, Popover, Tooltip or similar overlay before measuring. An `open` or `defaultOpen` prop the story passes through is the surest way.

snap warns about each of these when it sees them. See [How snap measures](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#how-snap-measures).

## What Figma can't do

These are true limits of Figma's platform. Each comes with what Storysync does about it.

- **Fonts Figma doesn't have.** A plugin can load only fonts already available in the Figma editor ([`loadFontAsync`](https://developers.figma.com/docs/plugins/api/properties/figma-loadfontasync/)), and the Plugin API can't install one. A font your code loads that Figma lacks is drawn in a stand-in at the measured weight, and the build names it. Install the font in Figma yourself. For system fonts, snap measures in the stand-in Figma will use, so widths match.
- **Clipping on one axis.** A Figma frame clips its content on both axes or neither ([`clipsContent: boolean`](https://developers.figma.com/docs/plugins/api/FrameNode/)). An element that clips one axis is built clipping both, and `figma code` names it.
- **A readback that proves where it came from.** The agent sends every line of code that runs in Figma, so no secret can be kept from it, and `use_figma` signs nothing. The readback checksum is a 32-bit FNV-1a over each entry, computed by the readback template that ships with Storysync. It catches a response edited, cut down or copied on the way, and a shortcut such as writing the readback from snap's values. It can't catch forgery, a readback reused after a fix round, or a template that echoes what it sent instead of reading the nodes. The [score test](#check-the-result) covers that: change an element in Figma by hand, read it back, and `verify` should report exactly that element.
- **One call's size.** `use_figma` takes at most 50,000 characters of code a call and returns at most 20kb ([write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas)), and it can't create images. `figma code` packs calls under these limits, reads continue with `figma next`, and pictures go through `upload_assets`.

## Reference

The [reference](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md) covers the rest:

- [Commands](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#commands): every command and its flags
- [How snap measures](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#how-snap-measures)
- [How the build works](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#how-the-build-works)
- [How verify scores](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#how-verify-scores)
- [Tokens](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#tokens): sources, values, dark mode and Tailwind
- [Props and variants](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#props-and-variants)
- [GitHub Action](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#github-action)
- [Troubleshooting](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#troubleshooting)
- [Non-goals](https://github.com/brendanciccone/storysync/blob/main/docs/reference.md#non-goals)

## License

MIT

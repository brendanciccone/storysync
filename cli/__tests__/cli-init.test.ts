// Runs the compiled `init` against fixture projects, answering its prompts on
// stdin, so the wiring from the installed Storybook to the addon-mcp release
// it offers is covered end to end. Nothing is installed: every answer to an
// install is no.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const MAIN_WITHOUT_ADDON = `export default { framework: "@storybook/react-vite", addons: [] };\n`;
const MAIN_WITH_ADDON = `export default { framework: "@storybook/react-vite", addons: ["@storybook/addon-mcp"] };\n`;

interface Fixture {
  /** Storybook's version in node_modules. */
  storybook: string;
  /** addon-mcp's version in node_modules, and declared in package.json; absent when not installed. */
  addon?: string;
}

/** A pnpm project with Storybook installed, and addon-mcp if `addon` is given. */
function withProject(fixture: Fixture, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "storysync-init-cli-"));
  const files: Record<string, string> = {
    ".storybook/main.ts": fixture.addon ? MAIN_WITH_ADDON : MAIN_WITHOUT_ADDON,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    // Declared as the older range: what is installed is what counts.
    "package.json": JSON.stringify({
      devDependencies: { storybook: "^10.5.0", ...(fixture.addon ? { "@storybook/addon-mcp": `^${fixture.addon}` } : {}) },
    }),
    "node_modules/storybook/package.json": JSON.stringify({ name: "storybook", version: fixture.storybook }),
  };
  if (fixture.addon) {
    files["node_modules/@storybook/addon-mcp/package.json"] = JSON.stringify({ name: "@storybook/addon-mcp", version: fixture.addon });
  }
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function init(dir: string, answers: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(process.execPath, [CLI, "init", "--project", dir], { input: answers, encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, "") };
}

test("init CLI: Storybook 10.5 is offered addon-mcp 0.7, quoted for the shell", () => {
  withProject({ storybook: "10.5.5" }, (dir) => {
    const r = init(dir, "n\nn\n");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Storybook 10\.1\+ \(found 10\.5\.5\)/);
    assert.match(r.out, /Install @storybook\/addon-mcp@\^0\.7\.0 via pnpm\?/);
    assert.match(r.out, /Skipped\. Run manually: pnpm add -D "@storybook\/addon-mcp@\^0\.7\.0"$/m);
    assert.equal(readFileSync(join(dir, ".storybook", "main.ts"), "utf8"), MAIN_WITHOUT_ADDON);
  });
});

test("init CLI: Storybook 10.6 is offered the addon-mcp release of its own version", () => {
  // package.json still says ^10.5.0; node_modules has 10.6.0, which is what runs.
  withProject({ storybook: "10.6.0" }, (dir) => {
    const r = init(dir, "n\nn\n");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Install @storybook\/addon-mcp@10\.6\.0 via pnpm\?/);
    assert.match(r.out, /Skipped\. Run manually: pnpm add -D @storybook\/addon-mcp@10\.6\.0$/m);
  });
});

test("init CLI: a Storybook prerelease older than the first lockstep addon-mcp is offered 0.7", () => {
  // addon-mcp was first published in lockstep at 10.6.0-alpha.4; there is no
  // @storybook/addon-mcp@10.6.0-alpha.1 to install.
  withProject({ storybook: "10.6.0-alpha.1" }, (dir) => {
    const r = init(dir, "n\nn\n");
    assert.match(r.out, /Skipped\. Run manually: pnpm add -D "@storybook\/addon-mcp@\^0\.7\.0"$/m);
  });
});

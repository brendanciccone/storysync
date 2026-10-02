// Runs the compiled `init` against fixture projects, answering its prompts on
// stdin, so the wiring from the installed Storybook to the addon-mcp release
// it offers is covered end to end. Nothing is installed: every answer to an
// install is no, except where a stand-in package manager on PATH records it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, basename, delimiter } from "node:path";
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

/** Runs init on `project`, from `cwd`: by default the project itself. */
function init(project: string, answers: string, env: NodeJS.ProcessEnv = process.env, cwd = project) {
  const r = spawnSync(process.execPath, [CLI, "init", "--project", project], { input: answers, encoding: "utf8", env, cwd });
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

test("init CLI: each piped answer goes to its own prompt", () => {
  // One readline per prompt used to swallow the second answer with the first,
  // so "n\ny\n" skipped the install and never registered the addon either.
  withProject({ storybook: "10.5.5" }, (dir) => {
    const r = init(dir, "n\ny\n");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Skipped\. Run manually/);
    assert.match(r.out, /Updated \.storybook\/main\.ts/);
    assert.match(readFileSync(join(dir, ".storybook", "main.ts"), "utf8"), /addons: \[\n\s+\{ name: "@storybook\/addon-mcp"/);
  });
});

test("init CLI: input that ends before an answer declines, rather than hanging or agreeing", () => {
  withProject({ storybook: "10.5.5" }, (dir) => {
    const r = init(dir, "");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Skipped\. Run manually/);
    assert.equal(readFileSync(join(dir, ".storybook", "main.ts"), "utf8"), MAIN_WITHOUT_ADDON);
  });
});

test("init CLI: addon-mcp 10.6 on Storybook 10.5 is reported, not passed as good", () => {
  // What init installed from 2026-09-02 until it pinned the version:
  // registered and in package.json, so every check passed, while Storybook
  // could not load its preset.
  withProject({ storybook: "10.5.5", addon: "10.6.0" }, (dir) => {
    const pkg = readFileSync(join(dir, "package.json"), "utf8");
    const r = init(dir, "n\n");
    assert.equal(r.status, 1, r.out);
    assert.doesNotMatch(r.out, /Everything looks good/);
    assert.match(r.out, /✖ @storybook\/addon-mcp installed \(found 10\.6\.0\)/);
    assert.match(r.out, /@storybook\/addon-mcp 10\.6\.0 needs Storybook 10\.6\.0 or later, but this project has Storybook 10\.5\.5, so Storybook can't load the addon\./);
    assert.match(r.out, /Install @storybook\/addon-mcp@\^0\.7\.0 via pnpm\?/);
    assert.match(r.out, /Skipped\. Run manually: pnpm add -D "@storybook\/addon-mcp@\^0\.7\.0"/);
    assert.match(r.out, /Or upgrade Storybook: pnpm dlx storybook@latest upgrade/);
    // Declining leaves it alone.
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), pkg);
  });
});

test("init CLI: accepting installs the matching addon-mcp, and the quoted spec reaches the package manager intact", { skip: process.platform === "win32" }, () => {
  withProject({ storybook: "10.5.5", addon: "10.6.0" }, (dir) => {
    // A stand-in pnpm that records its arguments, one per line.
    const bin = join(dir, ".bin-stand-in");
    const log = join(dir, "pnpm-args.txt");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
    chmodSync(join(bin, "pnpm"), 0o755);

    const r = init(dir, "y\n", { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(log, "utf8"), "add\n-D\n@storybook/addon-mcp@^0.7.0\n");
    assert.match(r.out, /Restart Storybook to apply changes/);
  });
});

test("init CLI: run from another directory, the commands it prints change into the project first", () => {
  // Pasted where init was run, `pnpm add` would add to that directory's
  // package.json, not the project's.
  withProject({ storybook: "9.1.20" }, (root) => {
    // The project is "my app" inside root, and init is run from root.
    const app = join(root, "my app");
    mkdirSync(app);
    for (const name of readdirSync(root)) if (name !== "my app") renameSync(join(root, name), join(app, name));
    const from = realpathSync(root);

    const r = init("my app", "n\nn\n", process.env, from);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Upgrade: cd "my app" && pnpm dlx storybook@latest upgrade$/m);
    assert.match(r.out, /Skipped\. Run manually: cd "my app" && pnpm add -D "@storybook\/addon-mcp@\^0\.7\.0"$/m);

    // From inside the project, there is nowhere to change to.
    const inside = init(".", "n\nn\n", process.env, join(from, "my app"));
    assert.match(inside.out, /Skipped\. Run manually: pnpm add -D "@storybook\/addon-mcp@\^0\.7\.0"$/m);
    // From below it, up.
    const below = init("..", "n\nn\n", process.env, join(from, "my app", ".storybook"));
    assert.match(below.out, /Skipped\. Run manually: cd \.\. && pnpm add -D "@storybook\/addon-mcp@\^0\.7\.0"$/m);
  });
  withProject({ storybook: "10.5.5", addon: "10.6.0" }, (dir) => {
    const r = init(dir, "n\n", process.env, dirname(realpathSync(dir)));
    assert.match(r.out, new RegExp(`Or upgrade Storybook: cd ${basename(dir)} && pnpm dlx storybook@latest upgrade$`, "m"));
  });
});

test("init CLI: with no Storybook config, the hint to set one up changes into the project", () => {
  const root = mkdtempSync(join(tmpdir(), "storysync-init-cli-"));
  try {
    mkdirSync(join(root, "app"));
    const r = init("app", "", process.env, realpathSync(root));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Initialize Storybook first: cd app && npx storybook init$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init CLI: a package in a pnpm workspace is offered pnpm, the workspace's package manager", () => {
  // npm can't install into a package with workspace: dependencies, and in
  // one without, it writes a second lockfile and node_modules beside pnpm's.
  withProject({ storybook: "10.5.5" }, (root) => {
    const ui = join(root, "packages", "ui");
    rmSync(join(root, ".storybook"), { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    mkdirSync(join(ui, ".storybook"), { recursive: true });
    writeFileSync(join(ui, ".storybook", "main.ts"), MAIN_WITHOUT_ADDON);
    writeFileSync(join(ui, "package.json"), JSON.stringify({
      dependencies: { "@acme/tokens": "workspace:*" },
      devDependencies: { storybook: "^10.5.0" },
    }));
    const r = init(ui, "n\nn\n");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Install @storybook\/addon-mcp@\^0\.7\.0 via pnpm\?/);
  });
});

test("init CLI: addon-mcp commented out of the config isn't registered, and is added to the live addons array", () => {
  withProject({ storybook: "10.6.0", addon: "10.6.0" }, (dir) => {
    const main = join(dir, ".storybook", "main.ts");
    writeFileSync(main, [
      "export default {",
      "  framework: \"@storybook/react-vite\",",
      "  // addons: [\"@storybook/addon-essentials\"],",
      "  addons: [",
      "    \"@storybook/addon-docs\",",
      "    // \"@storybook/addon-mcp\", // off until the upgrade",
      "  ],",
      "};",
      "",
    ].join("\n"));
    const r = init(dir, "y\n");
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Everything looks good/);
    assert.match(r.out, /✖ addon-mcp registered in addons array/);
    assert.match(r.out, /Updated \.storybook\/main\.ts/);
    const written = readFileSync(main, "utf8").split("\n");
    assert.equal(written[2], "  // addons: [\"@storybook/addon-essentials\"],");
    assert.equal(written[3], "  addons: [");
    assert.equal(written[4], "    { name: \"@storybook/addon-mcp\", options: { toolsets: { docs: true } } },");
  });
});

test("init CLI: an addon-mcp release that matches Storybook, or 0.7 on any Storybook 10, looks good", () => {
  for (const fixture of [{ storybook: "10.6.0", addon: "10.6.0" }, { storybook: "10.6.2", addon: "10.6.0" }, { storybook: "10.5.5", addon: "0.7.0" }]) {
    withProject(fixture, (dir) => {
      const r = init(dir, "");
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /✔ @storybook\/addon-mcp installed/);
      assert.match(r.out, /Everything looks good/);
    });
  }
});

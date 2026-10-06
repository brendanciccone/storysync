# Contributing to Storysync

Thanks for your interest in Storysync. This guide covers the basics for working on the project locally.

## Local development setup

Storysync uses [pnpm](https://pnpm.io/) as its package manager. The repo ships a `pnpm-lock.yaml`; other lockfiles are gitignored.

```bash
pnpm install
pnpm build
pnpm test
```

### Supply-chain protection

This project assumes contributors have [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) installed locally. Safe Chain wraps `npm`/`pnpm`/`yarn`/`npx`/`pip`/`uv`/`poetry` to block known-malicious packages and quarantine versions under 48 hours old at install time — defense against npm supply-chain attacks like Shai-Hulud.

Install it once with the command in [its README's Installation section](https://github.com/AikidoSec/safe-chain#installation). It downloads the install script from a pinned release and checks its SHA-256 before running it. The version and checksum change with every release, so copy the command from there. Then restart your terminal, and `pnpm safe-chain-verify` should print `OK: Safe-chain works!`.

No tokens or config required. Free and open source.

## Scripts

- `pnpm build` — compile TypeScript to `dist/`
- `pnpm dev` — incremental compile in watch mode
- `pnpm lint` — type-check without emitting
- `pnpm test` — build and run the node test runner suite
- `pnpm acceptance` — end-to-end checks against the example: build first, and start its Storybook (`cd examples/storybook-vite && pnpm storybook`). It drives the real CLI and runs the skill's readback and audit templates against simulated Figma nodes, so it catches regressions the unit tests can't; it is not run in CI.

## Submitting changes

- Keep commits focused and descriptive.
- Run `pnpm lint` and `pnpm test` before opening a pull request.
- Follow the existing code style (TypeScript, ESM, no semi-bikeshedding).

## Releasing

Releases are built and uploaded from CI, never from a laptop, and go live only after a maintainer approves them with 2FA. `.github/workflows/release.yml` runs when a version tag is pushed. It runs CI, stages the version on npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance, and creates the GitHub Release. Nothing reaches `npm install` until you approve it, so a leaked GitHub credential can't ship a release on its own.

1. On a branch, set the new version in both `package.json` and `cli/version.ts`. A test fails if they differ.
2. Merge to `main`.
3. Optional dry run: Actions → Release → Run workflow on `main`. It builds, tests and checks that npm accepts the workflow, but uploads nothing. It fails if npm doesn't trust the workflow.
4. Tag the merge commit and push only that tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.3.0
   git push origin v0.3.0
   ```

5. When the run finishes, approve the version on npmjs.com: account menu → **Staged Packages** → **Approve**, with 2FA. The button stays disabled until npm's malware scan finishes. The run's summary shows the tarball's shasum; approve only if the card shows the same one.

The tag must be `v` plus the exact `package.json` version, and it must point at a commit on `main`, or the workflow stops before staging. These checks catch mistakes; the approval in step 5 is what guards against misuse. Push one tag at a time: GitHub starts no workflow when more than three tags are pushed at once. A prerelease tag such as `v0.4.0-rc.1` goes to npm's `next` dist-tag and is marked as a prerelease on GitHub. If a run fails or is cancelled, re-run it: it skips what is already done. If you reject a staged version, delete its GitHub Release and tag before tagging again.

### One-time npm setup

npm has to trust the workflow before the first release. On npmjs.com, open the `storysync` package → Settings → Trusted Publisher → GitHub Actions, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `brendanciccone` |
| Repository | `storysync` |
| Workflow filename | `release.yml` |
| Environment name | *(leave blank)* |
| Allowed actions | leave **Allow npm publish** and **Allow npm dist-tag** unticked |

With both boxes unticked, the connection can only stage, which is what the workflow does. Fields are case-sensitive, and a connection can't be edited, only deleted and recreated. npm accepts a workflow if any of the package's connections match, so delete any other connection, especially one created before 20 May 2026 (npm set those to allow direct publishing) or one with **Allow npm publish** ticked.

Once a release has gone out this way, set Settings → Publishing access to "Require two-factor authentication and disallow tokens". Trusted publishing keeps working, and no npm token is stored in GitHub.

If the step fails with "npm did not accept this workflow", the connection doesn't match: compare it field by field with the table. The lines starting with `npm verbose oidc` in the log say why.

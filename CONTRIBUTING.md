# Contributing to storysync

Thanks for your interest in storysync. This guide covers the basics for working on the project locally.

## Local development setup

storysync uses [pnpm](https://pnpm.io/) as its package manager. The repo ships a `pnpm-lock.yaml`; other lockfiles are gitignored.

```bash
pnpm install
pnpm build
pnpm test
```

### Supply-chain protection

This project assumes contributors have [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) installed locally. Safe Chain wraps `npm`/`pnpm`/`yarn`/`npx`/`pip`/`uv`/`poetry` to block known-malicious packages and quarantine versions under 48 hours old at install time — defense against npm supply-chain attacks like Shai-Hulud.

One-time install:

```bash
curl -fsSL https://safechain.aikido.dev/install.sh | bash
# then restart your terminal
```

No tokens or config required. Free and open source.

## Scripts

- `pnpm build` — compile TypeScript to `dist/`
- `pnpm dev` — incremental compile in watch mode
- `pnpm lint` — type-check without emitting
- `pnpm test` — build and run the node test runner suite

## Submitting changes

- Keep commits focused and descriptive.
- Run `pnpm lint` and `pnpm test` before opening a pull request.
- Follow the existing code style (TypeScript, ESM, no semi-bikeshedding).

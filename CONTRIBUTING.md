# Contributing

Thanks for looking at OPNmesh. Bug reports, router notes for platforms other
than UniFi, and pull requests are all welcome.

## Ground rules

- **Read the design first**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
  It says what runs where and why. A change that contradicts it needs a
  change to it.
- **Tests run on Ubuntu.** Every layer has a suite; a change is done when its
  tests pass in CI, which runs on Ubuntu 24.04 with kernel WireGuard. See
  [docs/TESTING.md](docs/TESTING.md).
- **Generated configuration is security-sensitive.** Anything under
  `src/core/generate/` or `src/core/validate.ts` needs a unit test and, if it
  changes output, a reviewed golden-file diff (`npm run goldens:update`).
- **The agent stays small and suspicious.** It never runs commands the
  controller sends, writes only its allowlisted files, and keeps the tunnel up
  when the controller is gone.
- **No secrets in the repository.** CI greps for key material.

## Setting up

```bash
npm install
npm run dev            # controller on http://localhost:3000
npm test               # unit + API tests
npm run agent:test     # Go agent (in Docker)
npm run sim:up && npm run sim:test   # four-site simulation
```

## Style

TypeScript strict, small pure functions in `src/core`, comments that explain
*why*. UI copy is plain language: say what something means for the person's
network, not what the internal object is called.

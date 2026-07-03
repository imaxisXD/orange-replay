<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Orange Replay conventions

- **Design authority**: ARCHITECTURE.md. **Execution contract**: PLAN.md (ground rules, task scopes, logging contract). Read both before changing anything.
- Cost invariants are correctness: DO hibernation eligibility (hibernation WebSockets only, no timers outliving a request), minimal `setAlarm()` writes, idempotency by `(session, tab, seq)`, ingest path never decompresses payloads, sidecar scrubbing on by default, immutable R2 objects.
- **Logging**: wide events only — one JSON event per unit of work via the `@orange-replay/shared` logger, emitted in `finally`. No scattered `console.log`.
- **UI**: components come from the Fluid Functionalism shadcn registry (`npx shadcn@latest add @fluid/<component>`). Never hand-roll a component the registry provides.
- **Quality gates**: `vp check` and `vp test` must pass before any task is considered done.
- Workers code: no new dependencies without justification; prepared statements only for D1; validate R2 keys; authz on every API route.

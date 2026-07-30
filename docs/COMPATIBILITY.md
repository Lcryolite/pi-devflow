# Compatibility

## Supported runtime

| Component | Supported | Notes |
| --- | --- | --- |
| Node.js | 24.x | Enforced by `package.json` and platform smoke |
| Pi coding agent | 0.82.1 tested | Extension, TUI, RPC, session branch, model registry, and package manifest APIs |
| `@quintinshaw/pi-dynamic-workflows` | 3.4.1 | Exact runtime dependency |
| Linux | Ubuntu latest | Automated GitHub Actions smoke |
| macOS | macOS latest | Automated GitHub Actions smoke |
| Windows | Windows latest | Automated GitHub Actions smoke; PowerShell/cmd-safe script spawning |

Node releases below 24 are unsupported. Browser-only and remote runtimes without a writable Pi state directory are unsupported.

## Coexistence

| Package | Behavior with pi-devflow |
| --- | --- |
| `pi-codex-goal` | Session state can be imported. Disable after validation to avoid two Goal controllers. |
| `@juicesharp/rpiv-todo` | Latest Todo snapshot can be imported. Disable after validation to avoid two Todo tools. |
| `@quintinshaw/pi-dynamic-workflows` | Required and managed through one shared `WorkflowManager` per project session. |

`/devflow doctor` reports legacy Goal/Todo tool names but does not disable packages.

## Runtime modes

TUI and RPC support automatic follow-up continuation. Print and JSON modes can load state and use the tools, but do not trigger interactive follow-up turns; unresolved decisions remain durable blockers for a later TUI or RPC session.

## Checks

`npm run smoke:platform` runs the TypeScript compiler, test suite, package dry run, required-file check, and Pi manifest check. The GitHub Actions matrix runs the same command on all supported operating systems.

A successful local run proves only the local platform. Check the repository Actions page for the full matrix.

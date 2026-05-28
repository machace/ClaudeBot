## Guardrails (non-negotiable)

- **DECIDE is log-only.** Never wire it to live execution, never touch wallet/credential or risk-ceiling code without me explicitly asking in that session.
- **Compute signals on CLOSED candles only.** No look-ahead, no using the in-progress bar.
- **One change at a time.** Propose a plan and show diffs before writing. Don't batch edits across multiple files.
- **TypeScript must be type-safe and error-handled.** No experimental sketches.
- **The 8-asset whitelist, 3x leverage cap, and position/notional/reserve ceilings are fixed.** Don't modify them.

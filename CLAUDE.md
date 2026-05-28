# Autonomous AI Fund — Project Guardrails

## Non-negotiable rules
- DECIDE is log-only. Never wire it to live execution, never touch
  wallet/credential or risk-ceiling code without me explicitly asking
  in that session.
- Compute signals on CLOSED candles only. No look-ahead, no using the
  in-progress bar. ATR, returns, trends, correlations — all closed.
- One change at a time. Propose a plan and show diffs before writing.
  Don't batch edits across multiple files in one go.
- TypeScript must be type-safe and error-handled. No experimental
  sketches. `npx tsc --noEmit` must pass.
- The 8-asset whitelist (BTC, ETH, SOL, HYPE, LINK, ONDO, BNB, PENDLE)
  and the risk ceilings in .env are fixed. Don't modify them without
  me explicitly asking.

## Verification discipline
After any change that writes a file, claims to persist state, or modifies
behavior: verify with `cat`, `tail`, `ls`, or a dry-run cycle. Do not trust
"it should work" — confirm it did. Found two bugs this way already (the
equity_peak.json persistence and an empty CLAUDE.md).

## Current config state (28 May 2026)
- Network: mainnet (bot reads real market data every cycle; DRY_RUN is the
  only safety wheel)
- Equity: ~$26 (small testing balance)
- Position ceilings, tightened to match small equity:
  - HYPERLIQUID_MAX_LEVERAGE=2
  - HYPERLIQUID_MAX_POSITION_USD=12
  - HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD=25
  - HYPERLIQUID_MAX_CONCURRENT_POSITIONS=2
  - HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT=40 (matches project doc)

## Architecture state
- Tier 0 (baseline): equity, positions, 1h/4h/1d candles, funding, OI
- Tier 1 (landed, verified): RS rank across 8 assets, ATR%, MTF trend
  alignment. Confidence varies with alignment, stops scale with ATR,
  selection follows rank. See `scripts/experiment/signals.ts`.
- Tier 2 (landed, mostly dormant in log-only): pairwise correlation,
  net BTC-beta exposure, drawdown from persisted peak (data/equity_peak.json),
  total open risk (=0 until execution wired). Most rules can't fire
  without an open book; only size guidance is testable today.
- Tier 3 (not built): Hurst regime, liquidity sweeps, BB squeeze.
  All optional, experimental. Earn-their-place rule applies.

## Open findings
- size_usd anchors at $5 across cycles. Prompt guidance didn't move it.
  NEXT SESSION'S FIRST TASK: compute a deterministic size cap in code
  from ATR + confidence + equity, log it, pass it to the LLM as a
  bounded constraint rather than asking the model to pick a number.
  Same architectural pattern as the hard ceilings.
- Entry-thesis-on-open-positions input was parked from Tier 2 because
  it's untestable in log-only mode. Build it when execution goes live.
- totalOpenRisk reads $0 in log-only because stop prices live as
  trigger orders on Hyperliquid, not in the Position struct. Wire to
  real value when execution goes live.

## Project doc reference
The full project brief, operating principles, capital ramp, cadence,
and the human/AI partnership terms live in the Claude.ai project
instructions — not in this repo. Read those for the bigger picture.
This file is the operational context for Claude Code sessions.

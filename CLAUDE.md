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
- DECIDE_MODEL=claude-opus-4-8 (set 2026-05-28 20:38Z). Diary entries before
  that timestamp are Opus 4.7; from 20:38:25Z onward are 4.8.
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
- Tier 3 Build 1 (liquidity sweeps): landed, mechanically verified. Per-asset
  SwH/SwL/-- flag, 25%-overshoot retrace guard, whipsaw returns null. Builds 2
  (Hurst regime) and 3 (BB squeeze) not yet built.

## Open findings
- Tier 2 entry-thesis-on-open-positions feed: parked until execution
  goes live. Depends on holding real positions.
- Tier 2 totalOpenRisk reads $0 in log-only because stop prices live
  on Hyperliquid as trigger orders, not in the Position struct. Wires
  to real value when execution goes live.
- Size anchoring (was: open) — RESOLVED. Root cause was a toFixed(0)
  rounding artifact in the prompt, not a model defect. Caps now
  rendered to 2dp; at $26 equity the position-pct ceiling binds all
  confidence tiers to $5.28. Spread between tiers will appear at
  higher equity.
- sweep_influenced diary flag under-counts (regex /sweep/i misses 'SwH'-style
  citations); trust per-asset sweep state instead. OPEN QUESTION: do sweeps
  ever actually change a decision outcome, or are they logged-but-inert?
  Cannot answer in log-only mode — watch over many cycles / closed trades.
  Tier 3 as a whole is unvalidated: built under override, mechanically working,
  decision-quality impact unknown until closed trades exist.

## Next session decision
Two paths, decide deliberately:
  A. Move toward execution (testnet first, small $ on mainnet).
     This unlocks verification of Tier 2's diversification, open-risk,
     and drawdown rules, which cannot fire with an empty book.
  B. Build Tier 3 experimental signals (Hurst, liquidity sweeps,
     BB squeeze). Optional, earn-their-place. Adds signal but does
     not attack a measured defect.
Path A has higher information value. Path B is comfortable but
deferred work. Choose at session start.

## Project doc reference
The full project brief, operating principles, capital ramp, cadence,
and the human/AI partnership terms live in the Claude.ai project
instructions — not in this repo. Read those for the bigger picture.
This file is the operational context for Claude Code sessions.

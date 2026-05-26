/**
 * Hyperliquid risk ceilings
 *
 * Hard caps enforced before any order reaches the exchange.
 * Driven by env vars so they are visible in .env and auditable at a glance.
 * These checks run in the skill layer — the LLM cannot override them.
 *
 * All vars are optional; an unset var means that specific check is skipped.
 *
 * Env vars:
 *   HYPERLIQUID_MAX_LEVERAGE               e.g. "3"
 *   HYPERLIQUID_ALLOWED_ASSETS             e.g. "BTC,ETH,SOL,HYPE"  ("*" = no whitelist)
 *   HYPERLIQUID_MAX_POSITION_USD           per-coin absolute cap, e.g. "500"
 *   HYPERLIQUID_MAX_POSITION_PCT           per-coin % of portfolio, e.g. "10"
 *   HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD     total perp exposure cap, e.g. "2000"
 *   HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT  must keep this % un-exposed, e.g. "20"
 */

import { logger } from '../../../utils/logger';

export interface OrderCeilingParams {
  /** Asset symbol, e.g. "BTC" */
  coin: string;
  /** Direction of the new order */
  side: 'buy' | 'sell';
  /** Notional size of the new order in USD (size × price) */
  sizeUsd: number;
  /**
   * Leverage being set (only meaningful at /hl leverage time).
   * Pass 1 from order handlers — leverage ceiling is enforced at set-time.
   */
  leverage: number;
  /** true for perp orders, false for spot */
  isPerp: boolean;
  /** Current account equity in USD */
  portfolioValueUsd: number;
  /**
   * Existing position for this coin, signed.
   * Positive = long, negative = short, 0 = flat.
   */
  currentCoinPositionUsd: number;
  /** Sum of |all open perp positions| in USD before this order */
  totalOpenNotionalUsd: number;
}

export type CeilingResult = { allowed: true } | { allowed: false; reason: string };

function readEnvNum(name: string): number | null {
  const val = process.env[name];
  if (!val || val.trim() === '') return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

export function checkOrderAgainstCeilings(params: OrderCeilingParams): CeilingResult {
  const {
    coin,
    side,
    sizeUsd,
    leverage,
    isPerp,
    portfolioValueUsd,
    currentCoinPositionUsd,
    totalOpenNotionalUsd,
  } = params;

  const coinUpper = coin.toUpperCase();

  // ── 1. Leverage ceiling (perp only) ────────────────────────────────────────
  if (isPerp) {
    const maxLev = readEnvNum('HYPERLIQUID_MAX_LEVERAGE');
    if (maxLev !== null && leverage > maxLev) {
      const reason = `Requested leverage ${leverage}x exceeds HYPERLIQUID_MAX_LEVERAGE=${maxLev}x`;
      logger.warn({ coin: coinUpper, leverage, maxLev }, `HL ceiling blocked: ${reason}`);
      return { allowed: false, reason };
    }
  }

  // ── Exposure direction ──────────────────────────────────────────────────────
  // buy increases long / reduces short; sell increases short / reduces long.
  const signedChange = side === 'buy' ? sizeUsd : -sizeUsd;
  const projectedPositionUsd = currentCoinPositionUsd + signedChange;
  const projectedAbsUsd = Math.abs(projectedPositionUsd);
  const currentAbsUsd = Math.abs(currentCoinPositionUsd);
  const isIncreasingExposure = projectedAbsUsd > currentAbsUsd;

  // Trades that reduce existing exposure (closes, partial reduces) skip all
  // remaining checks so positions can always be unwound.
  if (!isIncreasingExposure) {
    return { allowed: true };
  }

  // ── 2. Asset whitelist ──────────────────────────────────────────────────────
  const allowedRaw = process.env.HYPERLIQUID_ALLOWED_ASSETS;
  if (allowedRaw && allowedRaw.trim() !== '' && allowedRaw.trim() !== '*') {
    const allowedAssets = allowedRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!allowedAssets.includes(coinUpper)) {
      const reason = `${coinUpper} is not in HYPERLIQUID_ALLOWED_ASSETS (${allowedRaw})`;
      logger.warn({ coin: coinUpper, allowedAssets }, `HL ceiling blocked: ${reason}`);
      return { allowed: false, reason };
    }
  }

  // ── 3. Per-coin absolute USD cap ────────────────────────────────────────────
  const maxPosUsd = readEnvNum('HYPERLIQUID_MAX_POSITION_USD');
  if (maxPosUsd !== null && projectedAbsUsd > maxPosUsd) {
    const reason = `${coinUpper} position would reach $${projectedAbsUsd.toFixed(0)} — ceiling HYPERLIQUID_MAX_POSITION_USD=$${maxPosUsd}`;
    logger.warn({ coin: coinUpper, projectedAbsUsd, maxPosUsd }, `HL ceiling blocked: ${reason}`);
    return { allowed: false, reason };
  }

  // ── 4. Per-coin % of portfolio cap ─────────────────────────────────────────
  const maxPosPct = readEnvNum('HYPERLIQUID_MAX_POSITION_PCT');
  if (maxPosPct !== null && portfolioValueUsd > 0) {
    const projectedPct = (projectedAbsUsd / portfolioValueUsd) * 100;
    if (projectedPct > maxPosPct) {
      const reason = `${coinUpper} would be ${projectedPct.toFixed(1)}% of portfolio — ceiling HYPERLIQUID_MAX_POSITION_PCT=${maxPosPct}%`;
      logger.warn({ coin: coinUpper, projectedPct, maxPosPct }, `HL ceiling blocked: ${reason}`);
      return { allowed: false, reason };
    }
  }

  // Projected total open notional across all coins after this trade
  const projectedTotalNotional = totalOpenNotionalUsd - currentAbsUsd + projectedAbsUsd;

  // ── 5. Total notional cap ───────────────────────────────────────────────────
  const maxTotalNotional = readEnvNum('HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD');
  if (maxTotalNotional !== null && projectedTotalNotional > maxTotalNotional) {
    const reason = `Total perp exposure would reach $${projectedTotalNotional.toFixed(0)} — ceiling HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD=$${maxTotalNotional}`;
    logger.warn({ projectedTotalNotional, maxTotalNotional }, `HL ceiling blocked: ${reason}`);
    return { allowed: false, reason };
  }

  // ── 6. Minimum portfolio reserve ────────────────────────────────────────────
  const minReservePct = readEnvNum('HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT');
  if (minReservePct !== null && portfolioValueUsd > 0) {
    const exposurePct = (projectedTotalNotional / portfolioValueUsd) * 100;
    const reservePct = 100 - exposurePct;
    if (reservePct < minReservePct) {
      const reserveDisplay = reservePct < 0
        ? `${(-reservePct).toFixed(1)}% over-exposed`
        : `${reservePct.toFixed(1)}% free`;
      const reason = `Total notional $${projectedTotalNotional.toFixed(0)} would consume portfolio reserve — need ${minReservePct}% free, would have ${reserveDisplay} (HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT=${minReservePct}%)`;
      logger.warn({ projectedTotalNotional, portfolioValueUsd, reservePct, minReservePct }, `HL ceiling blocked: ${reason}`);
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}

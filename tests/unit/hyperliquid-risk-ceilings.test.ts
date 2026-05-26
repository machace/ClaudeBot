import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrderAgainstCeilings, type OrderCeilingParams } from '../../src/skills/bundled/hyperliquid/risk-ceilings';

// Restore env vars after each test
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const baseParams: OrderCeilingParams = {
  coin: 'BTC',
  side: 'buy',
  sizeUsd: 100,
  leverage: 2,
  isPerp: true,
  portfolioValueUsd: 10_000,
  currentCoinPositionUsd: 0,
  totalOpenNotionalUsd: 0,
};

// 1a — leverage ceiling blocks when exceeded
test('leverage ceiling: blocks when leverage > MAX_LEVERAGE', () => {
  withEnv({ HYPERLIQUID_MAX_LEVERAGE: '3' }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, leverage: 5 });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_MAX_LEVERAGE'));
  });
});

// 1b — leverage ceiling passes when at or below limit
test('leverage ceiling: passes when leverage <= MAX_LEVERAGE', () => {
  withEnv({ HYPERLIQUID_MAX_LEVERAGE: '3' }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, leverage: 3 });
    assert.equal(result.allowed, true);
  });
});

// 1b — leverage ceiling skipped for spot orders
test('leverage ceiling: skipped for spot (isPerp=false)', () => {
  withEnv({ HYPERLIQUID_MAX_LEVERAGE: '1' }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, isPerp: false, leverage: 50 });
    assert.equal(result.allowed, true);
  });
});

// 1c — close (reducing exposure) always passes even with strict whitelist
test('closes always pass: sell reduces long exposure, bypasses whitelist', () => {
  withEnv({
    HYPERLIQUID_ALLOWED_ASSETS: 'ETH,SOL', // BTC NOT whitelisted
    HYPERLIQUID_MAX_POSITION_USD: '50',     // would block a buy of 100
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    // Selling 500 of a 1000 long — projectedAbs=500 < currentAbs=1000 → reducing
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      coin: 'BTC',
      side: 'sell',
      sizeUsd: 500,
      currentCoinPositionUsd: 1000, // long 1000
    });
    assert.equal(result.allowed, true);
  });
});

// 1c — flip case: sell that flips long→short IS increasing exposure and must be blocked
test('closes flip case: sell that flips long to short is increasing exposure', () => {
  withEnv({
    HYPERLIQUID_ALLOWED_ASSETS: 'ETH,SOL', // BTC NOT whitelisted
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    // Selling 2000 against a 1000 long → projected = -1000 → |−1000| > |+1000| is false...
    // Actually |projected| = 1000 = |current| = 1000, not greater. But selling 2000 from 1000 long:
    // projected = 1000 - 2000 = -1000, |projected| = 1000, |current| = 1000 → NOT increasing
    // The flip to short = same magnitude, so it passes the exposure gate.
    // To truly increase short exposure: sell 3000 against 1000 long → projected = -2000, |−2000| > |+1000|
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      coin: 'BTC',
      side: 'sell',
      sizeUsd: 3000,
      currentCoinPositionUsd: 1000, // long 1000
    });
    // projected = 1000 - 3000 = -2000, projectedAbsUsd=2000 > currentAbsUsd=1000 → increasing → blocked by whitelist
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_ALLOWED_ASSETS'));
  });
});

// 2 — asset whitelist blocks unlisted coin
test('whitelist: blocks unlisted coin', () => {
  withEnv({
    HYPERLIQUID_ALLOWED_ASSETS: 'ETH,SOL',
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, coin: 'BTC' });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_ALLOWED_ASSETS'));
  });
});

// 2 — wildcard allows all coins
test('whitelist: wildcard (*) allows any coin', () => {
  withEnv({
    HYPERLIQUID_ALLOWED_ASSETS: '*',
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, coin: 'DOGE' });
    assert.equal(result.allowed, true);
  });
});

// 3 — per-coin USD cap blocks
test('per-coin USD cap: blocks when projected position exceeds MAX_POSITION_USD', () => {
  withEnv({
    HYPERLIQUID_MAX_POSITION_USD: '500',
    HYPERLIQUID_ALLOWED_ASSETS: undefined,
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    // Current 400 long + buy 200 → projected 600 > 500 ceiling
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      sizeUsd: 200,
      currentCoinPositionUsd: 400,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_MAX_POSITION_USD'));
  });
});

// 4 — per-coin % cap blocks
test('per-coin % cap: blocks when projected position > MAX_POSITION_PCT of portfolio', () => {
  withEnv({
    HYPERLIQUID_MAX_POSITION_PCT: '10',
    HYPERLIQUID_ALLOWED_ASSETS: undefined,
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    // Portfolio 10_000, cap 10% = 1000. Buy 1100 → projected 1100 > 1000
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      sizeUsd: 1100,
      portfolioValueUsd: 10_000,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_MAX_POSITION_PCT'));
  });
});

// 5 — total notional cap blocks
test('total notional cap: blocks when total exposure would exceed MAX_TOTAL_NOTIONAL_USD', () => {
  withEnv({
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: '2000',
    HYPERLIQUID_ALLOWED_ASSETS: undefined,
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    // Existing total 1800, adding 300 BTC → projected 2100 > 2000
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      sizeUsd: 300,
      totalOpenNotionalUsd: 1800,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD'));
  });
});

// 6 — reserve floor blocks
test('reserve floor: blocks when reserve would drop below MIN_PORTFOLIO_RESERVE_PCT', () => {
  withEnv({
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: '20',
    HYPERLIQUID_ALLOWED_ASSETS: undefined,
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
  }, () => {
    // Portfolio 10_000, need 20% (2000) free. Buy 9000 → exposure=9000 → reserve=10% < 20%
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      sizeUsd: 9000,
      portfolioValueUsd: 10_000,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT'));
  });
});

// 6 — reserve message uses "over-exposed" when reserve goes negative
test('reserve floor: message says "over-exposed" when reserve is negative', () => {
  withEnv({
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: '20',
    HYPERLIQUID_ALLOWED_ASSETS: undefined,
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
  }, () => {
    // Portfolio 1000, buy 1500 → exposure=1500 → exposure%=150% → reserve=-50% → "over-exposed"
    const result = checkOrderAgainstCeilings({
      ...baseParams,
      sizeUsd: 1500,
      portfolioValueUsd: 1000,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('over-exposed'));
  });
});

// ceiling check order: leverage is tested before whitelist
test('ceiling ordering: leverage block fires before whitelist check', () => {
  withEnv({
    HYPERLIQUID_MAX_LEVERAGE: '2',
    HYPERLIQUID_ALLOWED_ASSETS: 'ETH',  // BTC excluded
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, leverage: 10 });
    assert.equal(result.allowed, false);
    assert.ok(result.allowed === false && result.reason.includes('HYPERLIQUID_MAX_LEVERAGE'));
  });
});

// no ceilings set → always passes
test('no ceilings set: order passes when all env vars unset', () => {
  withEnv({
    HYPERLIQUID_MAX_LEVERAGE: undefined,
    HYPERLIQUID_ALLOWED_ASSETS: undefined,
    HYPERLIQUID_MAX_POSITION_USD: undefined,
    HYPERLIQUID_MAX_POSITION_PCT: undefined,
    HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD: undefined,
    HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT: undefined,
  }, () => {
    const result = checkOrderAgainstCeilings({ ...baseParams, leverage: 50, sizeUsd: 999_999 });
    assert.equal(result.allowed, true);
  });
});

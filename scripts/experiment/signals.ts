/**
 * Tier 1 signal layer for DECIDE.
 * Pure functions only — no I/O, no exchange calls.
 * All computations use CLOSED candles (last bar always dropped).
 */

// ── TYPES ────────────────────────────────────────────────────────────────────
// Mirrored from decide.ts (structural typing keeps them compatible).
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

export interface AssetSnapshot {
  coin: string;
  midPrice: number;
  candles1h: Candle[];
  candles4h: Candle[];
  candles1d: Candle[];
}

export type Trend = 'up' | 'down' | 'flat';
export type MTFAlignment = 'aligned_up' | 'aligned_down' | 'mixed';

export interface AssetTier1 {
  coin: string;
  rsRank: number;       // 1 = strongest momentum, N = weakest
  atrPct: number;       // ATR(14, 1h) / lastClose × 100
  ret7d: number;        // % return over ~7 closed daily bars
  ret30d: number;       // % return over all available closed daily bars (~30d)
  trend1h: Trend;
  trend4h: Trend;
  trend1d: Trend;
  mtfAlign: MTFAlignment;
}

export interface Tier1Signals {
  computedAt: string;
  assets: AssetTier1[]; // sorted rsRank ascending (rank 1 first)
}

// ── INTERNAL HELPERS ─────────────────────────────────────────────────────────

/** Drop the last candle — may be in-progress. */
function closedCandles(arr: Candle[]): Candle[] {
  return arr.slice(0, -1);
}

/**
 * ATR(period, default 14) on 1h closed candles, as % of last close.
 * Returns 0 when there is insufficient data.
 */
function computeATR(candles: Candle[], period = 14): number {
  const c = closedCandles(candles);
  if (c.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i - 1].c),
      Math.abs(c[i].l - c[i - 1].c),
    ));
  }
  const atr = trs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const lastClose = c[c.length - 1].c;
  return lastClose > 0 ? (atr / lastClose) * 100 : 0;
}

/**
 * Price vs SMA(smaPeriod) trend on closed candles.
 * ±0.1% dead-band avoids noise at the boundary.
 */
function computeTrend(candles: Candle[], smaPeriod = 20): Trend {
  const c = closedCandles(candles);
  if (c.length < smaPeriod) return 'flat';
  const sma = c.slice(-smaPeriod).reduce((s, b) => s + b.c, 0) / smaPeriod;
  const last = c[c.length - 1].c;
  if (last > sma * 1.001) return 'up';
  if (last < sma * 0.999) return 'down';
  return 'flat';
}

/**
 * Percentile rank of value within an array.
 * 0.0 = lowest, 1.0 = highest.
 */
function pctRank(value: number, all: number[]): number {
  const n = all.length;
  if (n <= 1) return 0.5;
  const below = all.filter(v => v < value).length;
  return below / (n - 1);
}

// ── EXPORTED FUNCTIONS ────────────────────────────────────────────────────────

export function computeTier1(assets: AssetSnapshot[]): Tier1Signals {
  const raw = assets.map(snap => {
    const d = closedCandles(snap.candles1d);

    const ret7d: number = d.length >= 8
      ? ((d[d.length - 1].c - d[d.length - 8].c) / d[d.length - 8].c) * 100
      : 0;

    const ret30d: number = d.length >= 2
      ? ((d[d.length - 1].c - d[0].c) / d[0].c) * 100
      : 0;

    const smaDistance: number = (() => {
      if (d.length < 20) return 0;
      const sma = d.slice(-20).reduce((s, b) => s + b.c, 0) / 20;
      return sma > 0 ? ((d[d.length - 1].c - sma) / sma) * 100 : 0;
    })();

    const atrPct = computeATR(snap.candles1h);
    const trend1h = computeTrend(snap.candles1h);
    const trend4h = computeTrend(snap.candles4h);
    const trend1d = computeTrend(snap.candles1d);

    const upCount   = [trend1h, trend4h, trend1d].filter(t => t === 'up').length;
    const downCount = [trend1h, trend4h, trend1d].filter(t => t === 'down').length;
    const mtfAlign: MTFAlignment =
      upCount === 3   ? 'aligned_up'   :
      downCount === 3 ? 'aligned_down' :
      'mixed';

    return { coin: snap.coin, ret7d, ret30d, smaDistance, atrPct, trend1h, trend4h, trend1d, mtfAlign };
  });

  // Percentile-rank each momentum metric across all assets, then average.
  const all7d  = raw.map(r => r.ret7d);
  const all30d = raw.map(r => r.ret30d);
  const allSma = raw.map(r => r.smaDistance);

  const result: AssetTier1[] = raw
    .map(r => ({
      ...r,
      composite: (pctRank(r.ret7d, all7d) + pctRank(r.ret30d, all30d) + pctRank(r.smaDistance, allSma)) / 3,
    }))
    .sort((a, b) => b.composite - a.composite)
    .map((r, i): AssetTier1 => ({
      coin:     r.coin,
      rsRank:   i + 1,
      atrPct:   r.atrPct,
      ret7d:    r.ret7d,
      ret30d:   r.ret30d,
      trend1h:  r.trend1h,
      trend4h:  r.trend4h,
      trend1d:  r.trend1d,
      mtfAlign: r.mtfAlign,
    }));

  return { computedAt: new Date().toISOString(), assets: result };
}

const T: Record<Trend, string> = { up: '↑', down: '↓', flat: '~' };

// ── TIER 2 TYPES ─────────────────────────────────────────────────────────────

export interface CorrelationPair {
  a: string;
  b: string;
  corr: number;
}

/** Mirrored from decide.ts — structural typing keeps them compatible. */
export interface PositionForTier2 {
  coin: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  notional: number;
}

export interface Tier2Signals {
  computedAt: string;
  /** Upper-triangular pairs where |corr| >= 0.3. */
  correlations: CorrelationPair[];
  netExposureLine: string;
  drawdownPct: number;
  peakEquity: number;
  currentEquity: number;
  /** Always 0 in log-only mode — stop prices not in Position struct. */
  totalOpenRisk: number;
}

// ── TIER 2 HELPERS ────────────────────────────────────────────────────────────

function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  const xs = x.slice(-n), ys = y.slice(-n);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, sdx = 0, sdy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    sdx += dx * dx;
    sdy += dy * dy;
  }
  const denom = Math.sqrt(sdx * sdy);
  return denom === 0 ? 0 : num / denom;
}

// ── TIER 2 EXPORTS ────────────────────────────────────────────────────────────

export function computeTier2(
  assets: AssetSnapshot[],
  positions: PositionForTier2[],
  equity: number,
  peakEquity: number,
): Tier2Signals {
  // Log returns from closed daily candles
  const returnsMap: Record<string, number[]> = {};
  for (const snap of assets) {
    const c = closedCandles(snap.candles1d);
    const rets: number[] = [];
    for (let i = 1; i < c.length; i++) {
      if (c[i - 1].c > 0) rets.push(Math.log(c[i].c / c[i - 1].c));
    }
    returnsMap[snap.coin] = rets;
  }

  // Pairwise correlation — upper-triangular, compact (|corr| >= 0.3 only)
  const coins = assets.map(a => a.coin);
  const correlations: CorrelationPair[] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const corr = pearsonCorr(returnsMap[coins[i]] ?? [], returnsMap[coins[j]] ?? []);
      if (Math.abs(corr) >= 0.3) {
        correlations.push({ a: coins[i], b: coins[j], corr: Math.round(corr * 100) / 100 });
      }
    }
  }

  // Net exposure
  const btcReturns = returnsMap['BTC'] ?? [];
  let netLong = 0, netShort = 0, btcBetaUsd = 0;
  for (const pos of positions) {
    const sign = pos.side === 'long' ? 1 : -1;
    if (pos.side === 'long') netLong += pos.notional;
    else netShort += pos.notional;
    const btcCorr = pearsonCorr(returnsMap[pos.coin] ?? [], btcReturns);
    btcBetaUsd += sign * pos.notional * btcCorr;
  }

  let netExposureLine: string;
  if (positions.length === 0) {
    netExposureLine = 'net book: flat';
  } else {
    const btcBetaX = equity > 0 ? (btcBetaUsd / equity).toFixed(2) : '0.00';
    const sign = btcBetaUsd >= 0 ? '+' : '';
    netExposureLine = `net book: ${sign}${btcBetaX}x BTC-beta, $${netLong.toFixed(0)} notional long, $${netShort.toFixed(0)} short`;
  }

  const drawdownPct = peakEquity > 0
    ? Math.max(0, (peakEquity - equity) / peakEquity * 100)
    : 0;

  return {
    computedAt: new Date().toISOString(),
    correlations,
    netExposureLine,
    drawdownPct,
    peakEquity,
    currentEquity: equity,
    totalOpenRisk: 0,
  };
}

export function formatTier2Block(signals: Tier2Signals): string {
  const corrLine = signals.correlations.length === 0
    ? '(no significant correlations)'
    : signals.correlations
        .map(p => `${p.a}-${p.b}:${p.corr >= 0 ? '+' : ''}${p.corr.toFixed(2)}`)
        .join('  ');

  const ddStr = signals.drawdownPct > 0
    ? `${signals.drawdownPct.toFixed(1)}% below peak ($${signals.peakEquity.toFixed(2)})`
    : 'at or above peak';

  return [
    'TIER 2 SIGNALS',
    `Correlations (|r|≥0.3, 30d daily): ${corrLine}`,
    `Net exposure: ${signals.netExposureLine}`,
    `Drawdown: ${ddStr} | Open risk: $${signals.totalOpenRisk.toFixed(2)} at-stop`,
  ].join('\n');
}

export function formatTier1Block(signals: Tier1Signals): string {
  const n = signals.assets.length;
  const header =
    'TIER 1 SIGNALS (closed candles only)\n' +
    'Rank  Asset   ATR%    7d       30d      MTF(1h/4h/1d)';
  const rows = signals.assets.map(a => {
    const rank  = `${a.rsRank}/${n}`.padStart(3);
    const coin  = a.coin.padEnd(7);
    const atr   = `${a.atrPct.toFixed(1)}%`.padStart(5);
    const r7    = `${a.ret7d  >= 0 ? '+' : ''}${a.ret7d.toFixed(1)}%`.padStart(7);
    const r30   = `${a.ret30d >= 0 ? '+' : ''}${a.ret30d.toFixed(1)}%`.padStart(7);
    const arrows = T[a.trend1h] + T[a.trend4h] + T[a.trend1d];
    const align  =
      a.mtfAlign === 'aligned_up'   ? 'ALIGNED_UP'   :
      a.mtfAlign === 'aligned_down' ? 'ALIGNED_DOWN' :
      'mixed';
    return `${rank}  ${coin} ${atr}  ${r7}  ${r30}  ${arrows} ${align}`;
  });
  return [header, ...rows].join('\n');
}

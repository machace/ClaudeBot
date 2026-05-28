/**
 * DECIDE — autonomous trading decision script (v1).
 *
 * Fetches Hyperliquid account state + market data, asks Claude Opus 4.6
 * to decide what to do, validates against risk ceilings, logs to JSONL.
 *
 * v1 does NOT execute trades. v2 will, once decisions look sane.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { Hyperliquid } from 'hyperliquid';
import {
  computeTier1, formatTier1Block, type Tier1Signals,
  computeTier2, formatTier2Block, type Tier2Signals, type PositionForTier2,
  computeSizeCaps, formatSizeCapsBlock, type AssetSizeCap,
} from './signals';

dotenv.config({ path: '/home/kaan/clodds/.env' });

// ── CONFIG ──────────────────────────────────────────────────────────────────
const ASSETS = (process.env.HYPERLIQUID_ALLOWED_ASSETS || 'BTC,ETH,SOL').split(',').map(s => s.trim());
const MAX_LEVERAGE = parseInt(process.env.HYPERLIQUID_MAX_LEVERAGE || '3', 10);
const MAX_POSITION_USD = parseFloat(process.env.HYPERLIQUID_MAX_POSITION_USD || '200');
const MAX_POSITION_PCT = parseFloat(process.env.HYPERLIQUID_MAX_POSITION_PCT || '20');
const MAX_TOTAL_NOTIONAL_USD = parseFloat(process.env.HYPERLIQUID_MAX_TOTAL_NOTIONAL_USD || '2000');
const MIN_RESERVE_PCT = parseFloat(process.env.HYPERLIQUID_MIN_PORTFOLIO_RESERVE_PCT || '20');
const MAX_CONCURRENT = parseInt(process.env.HYPERLIQUID_MAX_CONCURRENT_POSITIONS || '5', 10);
const TESTNET = process.env.HYPERLIQUID_NETWORK === 'testnet';
const API_URL = TESTNET ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';

const DATA_DIR        = path.join(__dirname, '../../data');
const DIARY_PATH      = path.join(DATA_DIR, 'decisions.jsonl');
const EQUITY_PEAK_PATH = path.join(DATA_DIR, 'equity_peak.json');
const ANTHROPIC_MODEL = process.env.DECIDE_MODEL || 'claude-opus-4-7';

const log = (level: string, msg: string, data?: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data || {}) }));

// ── TYPES ───────────────────────────────────────────────────────────────────
interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

interface Position {
  coin: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
  notional: number;
}

interface AssetSnapshot {
  coin: string;
  midPrice: number;
  candles1h: Candle[];
  candles4h: Candle[];
  candles1d: Candle[];
}

interface MarketContext {
  timestamp: string;
  network: 'testnet' | 'mainnet';
  equity: number;
  marginUsed: number;
  availableMargin: number;
  positions: Position[];
  assets: AssetSnapshot[];
  recentDecisions: any[];
}

interface Decision {
  decision_type: 'open_new' | 'close_existing' | 'modify_existing' | 'no_action';
  asset: string | null;
  side: 'long' | 'short' | null;
  size_usd: number | null;
  leverage: number | null;
  stop_loss_pct: number | null;
  take_profit_levels: Array<{ gain_pct: number; close_fraction: number }> | null;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  market_view: string;
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
async function hlPost(body: object): Promise<any> {
  const res = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getCandles(coin: string, interval: string, lookbackMs: number): Promise<Candle[]> {
  const raw = await hlPost({
    type: 'candleSnapshot',
    req: { coin, interval, startTime: Date.now() - lookbackMs, endTime: Date.now() },
  });
  return (raw as any[]).map(c => ({
    t: c.t, o: parseFloat(c.o), h: parseFloat(c.h),
    l: parseFloat(c.l), c: parseFloat(c.c), v: parseFloat(c.v),
  }));
}

function readRecentDecisions(n: number): any[] {
  if (!fs.existsSync(DIARY_PATH)) return [];
  const lines = fs.readFileSync(DIARY_PATH, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function appendDiary(entry: object) {
  fs.appendFileSync(DIARY_PATH, JSON.stringify(entry) + '\n');
}

function readEquityPeak(currentEquity: number): number {
  try {
    if (fs.existsSync(EQUITY_PEAK_PATH)) {
      const data = JSON.parse(fs.readFileSync(EQUITY_PEAK_PATH, 'utf8'));
      return typeof data.peakEquity === 'number' ? data.peakEquity : currentEquity;
    }
  } catch { /* first run — treat current equity as peak */ }
  return currentEquity;
}

function writeEquityPeak(peak: number) {
  fs.writeFileSync(EQUITY_PEAK_PATH, JSON.stringify({ peakEquity: peak }));
}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

async function notifyTelegram(text: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e: any) {
    log('warn', 'telegram notify failed', { error: e.message });
  }
}

function formatDecisionMsg(d: Decision, ctx: MarketContext, execution: any): string {
  const net = ctx.network.toUpperCase();
  if (d.decision_type === 'no_action') {
    return `🤖 DECIDE — ${net}\nno_action | conf: ${d.confidence}\n"${(d.reasoning || '').slice(0, 200)}"\nequity: $${ctx.equity.toFixed(2)}`;
  }
  if (d.decision_type === 'open_new') {
    const tps = (d.take_profit_levels || []).map(t => `+${t.gain_pct}%`).join('/');
    const execNote = execution?.abortedToFlat ? '\n⚠️ ABORTED TO FLAT (stop failed)' : execution?.error ? `\n⚠️ ${execution.error}` : '';
    const fill = execution?.fillPrice ? ` @ $${execution.fillPrice}` : '';
    return `🤖 DECIDE — ${net}\nOPEN ${d.asset} ${d.side} | $${d.size_usd} @ ${d.leverage}x${fill}\nSL: -${d.stop_loss_pct}% | TP: ${tps} | conf: ${d.confidence}\n"${(d.reasoning || '').slice(0, 160)}"\nequity: $${ctx.equity.toFixed(2)}${execNote}`;
  }
  return `🤖 DECIDE — ${net}\n${d.decision_type} ${d.asset || ''} | conf: ${d.confidence}\nequity: $${ctx.equity.toFixed(2)}`;
}


// ── CONTEXT GATHERING ───────────────────────────────────────────────────────
async function gatherContext(vaultAddress: string): Promise<MarketContext> {
  const [state, mids] = await Promise.all([
    hlPost({ type: 'clearinghouseState', user: vaultAddress }),
    hlPost({ type: 'allMids' }),
  ]);

  const equity = parseFloat(state.marginSummary.accountValue);
  const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);

  const positions: Position[] = state.assetPositions
    .filter((ap: any) => parseFloat(ap.position.szi) !== 0)
    .map((ap: any) => {
      const size = parseFloat(ap.position.szi);
      const entryPrice = parseFloat(ap.position.entryPx);
      return {
        coin: ap.position.coin,
        side: (size > 0 ? 'long' : 'short') as 'long' | 'short',
        size: Math.abs(size),
        entryPrice,
        unrealizedPnl: parseFloat(ap.position.unrealizedPnl),
        leverage: parseFloat(ap.position.leverage?.value || '1'),
        notional: Math.abs(size) * entryPrice,
      };
    });

  const hourMs = 3_600_000;
  const dayMs = 86_400_000;
  const assets: AssetSnapshot[] = await Promise.all(
    ASSETS.map(async (coin) => ({
      coin,
      midPrice: parseFloat(mids[coin] || '0'),
      candles1h: await getCandles(coin, '1h', 30 * hourMs).catch(() => []),
      candles4h: await getCandles(coin, '4h', 30 * 4 * hourMs).catch(() => []),
      candles1d: await getCandles(coin, '1d', 30 * dayMs).catch(() => []),
    }))
  );

  return {
    timestamp: new Date().toISOString(),
    network: TESTNET ? 'testnet' : 'mainnet',
    equity, marginUsed,
    availableMargin: equity - marginUsed,
    positions, assets,
    recentDecisions: readRecentDecisions(10),
  };
}

// ── PROMPT ──────────────────────────────────────────────────────────────────
function buildPrompt(ctx: MarketContext, tier1: Tier1Signals, tier2: Tier2Signals, sizeCaps: AssetSizeCap[]): string {
  const equityRef = ctx.equity || 1000; // self-calibrating

  return `You are an autonomous trader managing a perpetual-futures account on Hyperliquid (${ctx.network}).

YOUR MANDATE
- Style: swing or trend trading. Hold positions for hours to days, not minutes.
- Goal: grow the account through directional macro/structural calls.
- Whitelisted assets: ${ASSETS.join(', ')}
- Hard limits (you cannot exceed these): leverage ≤ ${MAX_LEVERAGE}x, position size ≤ $${MAX_POSITION_USD} (or ${MAX_POSITION_PCT}% of equity, whichever is lower), max ${MAX_CONCURRENT} concurrent positions, ${MIN_RESERVE_PCT}% reserve must stay un-deployed.
- You decide everything else: which asset, direction, size, leverage, entry, stop-loss, take-profit. You may also do nothing.

CURRENT STATE
- Time: ${ctx.timestamp}
- Network: ${ctx.network}
- Equity: $${ctx.equity.toFixed(2)}
- Margin used: $${ctx.marginUsed.toFixed(2)} (available: $${ctx.availableMargin.toFixed(2)})
- Current positions: ${ctx.positions.length === 0 ? 'NONE' : JSON.stringify(ctx.positions, null, 2)}

RECENT MARKET DATA (last 30 candles per asset)
${ctx.assets.map(a => `
${a.coin} — mid: $${a.midPrice.toFixed(2)}
  1h (last 5): ${a.candles1h.slice(-5).map(c => `O${c.o.toFixed(2)} H${c.h.toFixed(2)} L${c.l.toFixed(2)} C${c.c.toFixed(2)}`).join(' | ')}
  4h (last 5): ${a.candles4h.slice(-5).map(c => `O${c.o.toFixed(2)} H${c.h.toFixed(2)} L${c.l.toFixed(2)} C${c.c.toFixed(2)}`).join(' | ')}
  1d (last 5): ${a.candles1d.slice(-5).map(c => `O${c.o.toFixed(2)} H${c.h.toFixed(2)} L${c.l.toFixed(2)} C${c.c.toFixed(2)}`).join(' | ')}
`).join('\n')}

${formatTier1Block(tier1)}

${formatTier2Block(tier2)}

${formatSizeCapsBlock(sizeCaps)}

SIZING & CONVICTION RULES (applied before each decision)
- Asset selection: trade by RS rank. For longs, prefer lower-ranked assets (rank 1 = strongest momentum). For shorts, prefer higher-ranked assets (rank 8 = weakest momentum). Ranks 4–5 are borderline — require a clear signal.
- Leverage: 2–3× only when ATR% ≤ 2% AND MTF is ALIGNED (either direction). Cap at 1–2× when ATR% > 3%. Rule applies equally to longs and shorts.
- Confidence "high": ALIGNED_UP (long) or ALIGNED_DOWN (short). "medium": 2/3 timeframes agree. "low": 1/3 or fewer.
- no_action: use only when NO asset clears the bar. An asset clears the bar when it has ALIGNED_UP MTF + positive 7d AND 30d returns (long candidate) OR ALIGNED_DOWN MTF + negative 7d AND 30d returns (short candidate). If even one asset meets either criterion, there is a setup — pick the best qualifying asset and act. Do not output no_action just because most assets are mixed.
- Correlation doubling: two positions carry effectively the same exposure when they move together in your portfolio — long+long with corr > 0.7, OR long+short with corr < −0.7 (opposite direction on an inversely-correlated pair is still one concentrated bet, because both move against you in the same scenario). If either condition holds against any existing position, treat the pair as a single concentrated bet. Require unusually strong conviction (high + ALIGNED MTF + aligned 7d/30d returns + RS rank 1–2) or reduce size by at least half.
- Open risk cap: total open risk (Tier 2 "Open risk" line) must stay well under 10% of equity. If this trade would push it over that threshold, reduce size proportionally or use no_action.
- Drawdown throttle: if drawdown from peak equity exceeds 15%, cap ALL new position sizes at half of what you would otherwise choose. State this throttle explicitly in your reasoning field whenever it applies. The throttle lifts when equity recovers to within 5% of peak.
- Size: size_usd must fall between $5 floor and the computed cap for the chosen asset at your selected confidence level. Caps are shown in the SIZING CAPS block above (one row per asset, three columns: high/med/low). Use the full cap for clean high-conviction setups; size below the cap when conviction is reduced. Do not exceed the cap under any circumstances.
- Liquidity sweep: when an asset shows 'SwL' (recent sweep of swing low followed by close back above) treat as added long evidence — confirms stop-hunt absorbed by buyers. Mirror for 'SwH' as short evidence. A sweep is supporting evidence only — do not trade on a sweep alone without MTF and RS support. Cite the sweep in reasoning when it influenced the decision.

YOUR DECISION LOG (last 10)

IMPORTANT: This is a log of decisions you've made. NOT all of these were executed on the exchange — many are dry-run-mode entries that produced no actual position. Your authoritative position state is the "Current positions" field in CURRENT STATE above. If positions shows NONE, you hold NOTHING, regardless of what this log shows. Don't reason as if logged decisions are open positions.
${ctx.recentDecisions.length === 0 ? '(no prior decisions yet — this is your first cycle)' :
  ctx.recentDecisions.map(d => `[${d.timestamp}] ${d.decision?.decision_type || 'n/a'} ${d.decision?.asset || ''} ${d.decision?.side || ''} ${d.decision?.size_usd ? '$'+d.decision.size_usd : ''} — ${d.decision?.reasoning?.slice(0, 100) || 'n/a'}`).join('\n')}

INSTRUCTIONS
Decide one of:
1. open_new — open a new position on an asset you don't currently hold
2. close_existing — close one of your current positions entirely
3. modify_existing — adjust take-profit/stop on a current position (without closing)
4. no_action — nothing worth doing this cycle

Respond with EXACTLY this JSON structure, no other text:
{
  "decision_type": "open_new" | "close_existing" | "modify_existing" | "no_action",
  "asset": "BTC" | "ETH" | ... | null,
  "side": "long" | "short" | null,
  "size_usd": number | null,
  "leverage": number | null,
  "stop_loss_pct": number | null,
  "take_profit_levels": [ { "gain_pct": number, "close_fraction": number } ] | null,
  "confidence": "low" | "medium" | "high",
  "reasoning": "2-4 sentences explaining your decision and why this is a swing/trend setup, not a scalp",
  "market_view": "1-2 sentences on the overall market regime right now"
}
Take-profit guidance:
- Provide 1 to 4 take_profit_levels for any open_new.
- gain_pct is the % price move in your favor that triggers that level (always positive).
- close_fraction is the fraction of the position to close at that level; the fractions must sum to 1.0 or less. If they sum to less than 1.0, the remainder rides until the stop or a future decision.
- Space the levels according to volatility: wider gaps for more volatile assets, tighter for calmer ones. You decide how many levels and where.
- Example: [{ "gain_pct": 5, "close_fraction": 0.4 }, { "gain_pct": 9, "close_fraction": 0.35 }, { "gain_pct": 15, "close_fraction": 0.25 }]

Critical rules:
- size_usd is the NOTIONAL value (size × price), NOT the margin. Stay under $${Math.min(MAX_POSITION_USD, equityRef * MAX_POSITION_PCT / 100).toFixed(2)}.
- Don't open if you already have ${MAX_CONCURRENT} positions.
- Don't open if available margin < ${MIN_RESERVE_PCT}% of equity.
- "no_action" only when no asset clears the bar — see SIZING & CONVICTION RULES above.`;
}

// ── ANTHROPIC ───────────────────────────────────────────────────────────────
async function askLLM(prompt: string): Promise<{ decision: Decision; raw: string; usage: any }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
  // Strip markdown fences if present
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const decision = JSON.parse(cleaned) as Decision;
  return { decision, raw, usage: response.usage };
}

// ── VALIDATION ──────────────────────────────────────────────────────────────
function validateDecision(d: Decision, ctx: MarketContext): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (d.decision_type === 'no_action') return { ok: true, reasons: [] };

  if (d.decision_type === 'open_new') {
    if (!d.asset || !ASSETS.includes(d.asset)) reasons.push(`asset ${d.asset} not in whitelist`);
    if (!d.side) reasons.push('side missing');
    if (!d.size_usd || d.size_usd <= 0) reasons.push('size_usd missing or invalid');
    if (d.size_usd && d.size_usd > MAX_POSITION_USD) reasons.push(`size_usd ${d.size_usd} > MAX_POSITION_USD ${MAX_POSITION_USD}`);
    if (d.size_usd && d.size_usd > ctx.equity * MAX_POSITION_PCT / 100) reasons.push(`size_usd ${d.size_usd} > ${MAX_POSITION_PCT}% of equity`);
    if (d.leverage && d.leverage > MAX_LEVERAGE) reasons.push(`leverage ${d.leverage} > MAX_LEVERAGE ${MAX_LEVERAGE}`);
    if (ctx.positions.length >= MAX_CONCURRENT) reasons.push(`already at MAX_CONCURRENT (${MAX_CONCURRENT})`);
    if (ctx.positions.some(p => p.coin === d.asset)) reasons.push(`already have position in ${d.asset}`);
    const newTotal = ctx.positions.reduce((s, p) => s + p.notional, 0) + (d.size_usd || 0);
    if (newTotal > MAX_TOTAL_NOTIONAL_USD) reasons.push(`new total notional ${newTotal} > MAX_TOTAL_NOTIONAL_USD ${MAX_TOTAL_NOTIONAL_USD}`);
    if (!d.stop_loss_pct || d.stop_loss_pct <= 0) reasons.push('stop_loss_pct missing or invalid');
    if (!d.take_profit_levels || d.take_profit_levels.length === 0) {
      reasons.push('take_profit_levels missing');
    } else {
      if (d.take_profit_levels.length > 4) reasons.push('more than 4 take_profit_levels');
      const fracSum = d.take_profit_levels.reduce((s, t) => s + (t.close_fraction || 0), 0);
      if (fracSum > 1.0001) reasons.push(`close_fraction sum ${fracSum.toFixed(3)} > 1.0`);
      if (d.take_profit_levels.some(t => !t.gain_pct || t.gain_pct <= 0)) reasons.push('a take_profit level has invalid gain_pct');
      if (d.take_profit_levels.some(t => !t.close_fraction || t.close_fraction <= 0)) reasons.push('a take_profit level has invalid close_fraction');
    }
  }
  if (d.decision_type === 'close_existing' || d.decision_type === 'modify_existing') {
    if (!d.asset) reasons.push('asset missing');
    if (!ctx.positions.some(p => p.coin === d.asset)) reasons.push(`no current position in ${d.asset}`);
  }
  return { ok: reasons.length === 0, reasons };
}


// ── EXECUTION ───────────────────────────────────────────────────────────────
import * as hl from '/home/kaan/clodds/dist/exchanges/hyperliquid/index.js';

interface ExecResult {
  attempted: boolean;
  dryRun: boolean;
  steps: any[];
  fillPrice?: number;
  slOrderId?: number;
  tpOrderIds?: number[];
  abortedToFlat?: boolean;
  error?: string;
}

const HL_CONFIG = {
  walletAddress: process.env.HYPERLIQUID_VAULT_ADDRESS!,
  privateKey: process.env.HYPERLIQUID_AGENT_KEY!,
  testnet: TESTNET,
  dryRun: process.env.DRY_RUN === 'true',
};

async function placeStopWithRetry(coin: string, side: 'BUY' | 'SELL', size: number, triggerPx: number, maxTries = 3) {
  let last: any;
  for (let i = 1; i <= maxTries; i++) {
    const r = await hl.placeTriggerOrder(HL_CONFIG, { coin, side, size, triggerPx, tpsl: 'sl', isMarket: true });
    if (r.success) return { success: true, orderId: r.orderId, tries: i };
    last = r;
    log('warn', 'stop placement failed, retrying', { try: i, error: r.error });
    await new Promise(res => setTimeout(res, 1000));
  }
  return { success: false, error: last?.error, tries: maxTries };
}

async function executeDecision(d: Decision, ctx: MarketContext): Promise<ExecResult> {
  const result: ExecResult = { attempted: true, dryRun: HL_CONFIG.dryRun, steps: [] };

  if (d.decision_type === 'no_action') {
    return { attempted: false, dryRun: HL_CONFIG.dryRun, steps: [] };
  }

  if (d.decision_type === 'open_new') {
    const coin = d.asset!;
    const orderSide = d.side === 'long' ? 'BUY' : 'SELL';
    const closeSide = d.side === 'long' ? 'SELL' : 'BUY';
    const asset = ctx.assets.find(a => a.coin === coin)!;
    const px = asset.midPrice;
    const size = parseFloat((d.size_usd! / px).toFixed(5));

    // 1. Open with leverage
    const open = await hl.placePerpOrder(HL_CONFIG, { coin, side: orderSide, size, type: 'MARKET', leverage: d.leverage! });
    result.steps.push({ step: 'open', result: open });
    if (!open.success) { result.error = `open failed: ${open.error}`; return result; }

    // 2. Determine fill price — real state if live, mid if dry-run
    let fillPx = px;
    if (!HL_CONFIG.dryRun) {
      await new Promise(res => setTimeout(res, 2000));
      const state = await hlPost({ type: 'clearinghouseState', user: HL_CONFIG.walletAddress });
      const pos = state.assetPositions.find((p: any) => p.position.coin === coin);
      if (pos) fillPx = parseFloat(pos.position.entryPx);
    }
    result.fillPrice = fillPx;

    // 3. Stop-loss (retry-then-abort)
    const slPx = d.side === 'long' ? fillPx * (1 - d.stop_loss_pct! / 100) : fillPx * (1 + d.stop_loss_pct! / 100);
    const sl = await placeStopWithRetry(coin, closeSide, size, slPx);
    result.steps.push({ step: 'stop_loss', triggerPx: slPx, result: sl });
    if (!sl.success) {
      // abort-to-flat: stop could not be placed, close the position
      log('error', 'stop placement failed after retries — aborting to flat', { coin });
      const flat = await hl.placePerpOrder(HL_CONFIG, { coin, side: closeSide, size, type: 'MARKET', reduceOnly: true });
      result.steps.push({ step: 'abort_to_flat', result: flat });
      result.abortedToFlat = true;
      result.error = 'stop placement failed, position closed';
      return result;
    }
    result.slOrderId = sl.orderId;

    // 4. Take-profit levels
    const tpIds: number[] = [];
    for (const tp of d.take_profit_levels!) {
      const tpPx = d.side === 'long' ? fillPx * (1 + tp.gain_pct / 100) : fillPx * (1 - tp.gain_pct / 100);
      const tpSize = parseFloat((size * tp.close_fraction).toFixed(5));
      const r = await hl.placeTriggerOrder(HL_CONFIG, { coin, side: closeSide, size: tpSize, triggerPx: tpPx, tpsl: 'tp', isMarket: true });
      result.steps.push({ step: 'take_profit', gain_pct: tp.gain_pct, triggerPx: tpPx, size: tpSize, result: r });
      if (r.success && r.orderId) tpIds.push(r.orderId);
    }
    result.tpOrderIds = tpIds;
    return result;
  }

  if (d.decision_type === 'close_existing') {
    const coin = d.asset!;
    const pos = ctx.positions.find(p => p.coin === coin)!;
    const closeSide = pos.side === 'long' ? 'SELL' : 'BUY';
    const close = await hl.placePerpOrder(HL_CONFIG, { coin, side: closeSide, size: pos.size, type: 'MARKET', reduceOnly: true });
    result.steps.push({ step: 'close', result: close });
    if (!close.success) result.error = close.error;
    return result;
  }

  // modify_existing: deferred — log and no-op for now
  result.steps.push({ step: 'modify_existing', note: 'not yet implemented in v2' });
  return result;
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const vault = process.env.HYPERLIQUID_VAULT_ADDRESS;
  if (!vault) throw new Error('HYPERLIQUID_VAULT_ADDRESS not set');

  log('info', 'DECIDE cycle starting', { network: TESTNET ? 'testnet' : 'mainnet', vault });

  const ctx = await gatherContext(vault);
  log('info', 'context gathered', {
    equity: ctx.equity, positions: ctx.positions.length, assetsFetched: ctx.assets.length,
  });

  const tier1 = computeTier1(ctx.assets);
  const sizeCaps = computeSizeCaps(tier1.assets, ctx.equity, MAX_POSITION_USD, MAX_POSITION_PCT);
  const storedPeak = readEquityPeak(ctx.equity);
  const peakEquity = Math.max(storedPeak, ctx.equity);
  if (!fs.existsSync(EQUITY_PEAK_PATH) || peakEquity > storedPeak) writeEquityPeak(peakEquity);
  const tier2 = computeTier2(ctx.assets, ctx.positions, ctx.equity, peakEquity);
  const prompt = buildPrompt(ctx, tier1, tier2, sizeCaps);
  const { decision, raw, usage } = await askLLM(prompt);
  log('info', 'LLM responded', { usage, decision_type: decision.decision_type });

  const appliedSizeCap = (() => {
    if (decision.decision_type !== 'open_new' || !decision.asset || !decision.confidence) return null;
    const cap = sizeCaps.find(c => c.coin === decision.asset);
    if (!cap) return null;
    return decision.confidence === 'high' ? cap.capHigh
         : decision.confidence === 'medium' ? cap.capMed
         : cap.capLow;
  })();

  const validation = validateDecision(decision, ctx);

  // Execute only if validation passed and it's an actionable decision
  let execution: ExecResult | null = null;
  if (validation.ok && decision.decision_type !== 'no_action') {
    log('info', 'executing decision', { type: decision.decision_type, dryRun: HL_CONFIG.dryRun });
    execution = await executeDecision(decision, ctx);
    log('info', 'execution complete', { dryRun: execution.dryRun, abortedToFlat: execution.abortedToFlat, error: execution.error });
  }

  const entry = {
    timestamp: ctx.timestamp,
    network: ctx.network,
    equity: ctx.equity,
    positions_before: ctx.positions,
    decision,
    tier1_signals: tier1,
    size_caps: sizeCaps,
    applied_size_cap: appliedSizeCap,
    tier2_signals: tier2,
    validation,
    llm_usage: usage,
    executed: execution?.attempted ?? false,
    execution,
    // v1: detects "sweep" in reasoning text. Under-counts — model may cite
    // "swing high rejected" or similar phrasing without the word "sweep".
    sweep_influenced: /sweep/i.test(decision.reasoning ?? ''),
    notes: HL_CONFIG.dryRun ? 'v2 dry-run: execution path fired, no real orders' : 'v2 live execution',
  };
  appendDiary(entry);

  log('info', 'decision logged', {
    decision_type: decision.decision_type,
    asset: decision.asset,
    valid: validation.ok,
    reasons: validation.reasons,
  });

try {
    await notifyTelegram(formatDecisionMsg(decision, ctx, execution));
  } catch (e: any) {
    log('warn', 'notify step failed (non-fatal)', { error: e.message });
  }

  console.log('\n=== DECISION ===\n' + JSON.stringify(decision, null, 2));
  console.log('\n=== VALIDATION ===\n' + JSON.stringify(validation, null, 2));
  if (!validation.ok) {
    console.log('\n⚠️  Decision would be REJECTED by risk ceilings. Logged for analysis.');
  }
}

main().catch(err => {
  log('error', 'DECIDE failed', { error: err.message, stack: err.stack });
  process.exit(1);
});

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
import Anthropic from '@anthropic-ai/sdk';
import { Hyperliquid } from 'hyperliquid';

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

const DIARY_PATH = '/home/kaan/clodds/data/decisions.jsonl';
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
  take_profit_pct: number | null;
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
function buildPrompt(ctx: MarketContext): string {
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
  "take_profit_pct": number | null,
  "confidence": "low" | "medium" | "high",
  "reasoning": "2-4 sentences explaining your decision and why this is a swing/trend setup, not a scalp",
  "market_view": "1-2 sentences on the overall market regime right now"
}

Critical rules:
- size_usd is the NOTIONAL value (size × price), NOT the margin. Stay under $${Math.min(MAX_POSITION_USD, equityRef * MAX_POSITION_PCT / 100).toFixed(0)}.
- Don't open if you already have ${MAX_CONCURRENT} positions.
- Don't open if available margin < ${MIN_RESERVE_PCT}% of equity.
- "no_action" is a valid choice. Don't trade unless there's a real setup.`;
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
  }
  if (d.decision_type === 'close_existing' || d.decision_type === 'modify_existing') {
    if (!d.asset) reasons.push('asset missing');
    if (!ctx.positions.some(p => p.coin === d.asset)) reasons.push(`no current position in ${d.asset}`);
  }
  return { ok: reasons.length === 0, reasons };
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

  const prompt = buildPrompt(ctx);
  const { decision, raw, usage } = await askLLM(prompt);
  log('info', 'LLM responded', { usage, decision_type: decision.decision_type });

  const validation = validateDecision(decision, ctx);

  const entry = {
    timestamp: ctx.timestamp,
    network: ctx.network,
    equity: ctx.equity,
    positions_before: ctx.positions,
    decision,
    validation,
    llm_usage: usage,
    executed: false, // v1 never executes
    notes: 'v1: decision logged only, not executed on exchange',
  };
  appendDiary(entry);

  log('info', 'decision logged', {
    decision_type: decision.decision_type,
    asset: decision.asset,
    valid: validation.ok,
    reasons: validation.reasons,
  });

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

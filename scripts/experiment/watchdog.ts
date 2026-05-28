/**
 * WATCHDOG — continuous position-safety loop. No LLM, no decisions.
 *
 * Single invariant: every open position must have a resting stop-loss.
 * Polls every POLL_SECONDS. If a position lacks a stop, reconstruct one
 * (from the diary's original stop_loss_pct if found, else a default %).
 * If placing the stop fails, close the position. It only ever REDUCES risk.
 *
 * Runs independently of DECIDE — keeps protecting positions even if
 * DECIDE is stopped. Read-only except for placing stops / closing positions.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config({ path: '/home/kaan/clodds/.env' });
import * as hl from '/home/kaan/clodds/dist/exchanges/hyperliquid/index.js';

const TESTNET = process.env.HYPERLIQUID_NETWORK === 'testnet';
const API_URL = TESTNET ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';
const POLL_SECONDS = parseInt(process.env.WATCHDOG_POLL_SECONDS || '30', 10);
const GRACE_SECONDS = parseInt(process.env.WATCHDOG_GRACE_SECONDS || '90', 10);
const DEFAULT_STOP_PCT = parseFloat(process.env.WATCHDOG_DEFAULT_STOP_PCT || '5');
const DIARY_PATH = '/home/kaan/clodds/data/decisions.jsonl';
const VAULT = process.env.HYPERLIQUID_VAULT_ADDRESS!;

const HL_CONFIG = {
  walletAddress: VAULT,
  privateKey: process.env.HYPERLIQUID_AGENT_KEY!,
  testnet: TESTNET,
  dryRun: process.env.DRY_RUN === 'true',
};

const log = (level: string, msg: string, data?: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, comp: 'watchdog', ...(data || {}) }));

async function hlPost(body: object): Promise<any> {
  const res = await fetch(`${API_URL}/info`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}: ${await res.text()}`);
  return res.json();
}

async function latestOpenFillTime(coin: string): Promise<number | null> {
  const fills = await hlPost({ type: 'userFills', user: VAULT });
  for (const f of (fills || [])) {
    if (f.coin === coin && typeof f.dir === 'string' && f.dir.startsWith('Open')) {
      return f.time; // fills are newest-first; first Open match is the most recent
    }
  }
  return null;
}

// Find the most recent open_new decision for this coin to recover its stop_loss_pct
function findOriginalStopPct(coin: string): number | null {
  if (!fs.existsSync(DIARY_PATH)) return null;
  const lines = fs.readFileSync(DIARY_PATH, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.decision?.decision_type === 'open_new' && e.decision?.asset === coin && e.decision?.stop_loss_pct) {
        return e.decision.stop_loss_pct;
      }
    } catch { /* skip */ }
  }
  return null;
}

async function checkOnce() {
  const [state, openOrders] = await Promise.all([
    hlPost({ type: 'clearinghouseState', user: VAULT }),
    hlPost({ type: 'frontendOpenOrders', user: VAULT }),
  ]);

  const positions = state.assetPositions.filter((p: any) => parseFloat(p.position.szi) !== 0);
  if (positions.length === 0) { log('info', 'no open positions'); return; }

  // Which coins have a resting stop?
  const coinsWithStop = new Set(
    openOrders
      .filter((o: any) => o.isTrigger && o.orderType === 'Stop Market' && o.reduceOnly)
      .map((o: any) => o.coin)
  );

  for (const ap of positions) {
    const coin = ap.position.coin;
    const szi = parseFloat(ap.position.szi);
    const side = szi > 0 ? 'long' : 'short';
    const size = Math.abs(szi);

    if (coinsWithStop.has(coin)) {
      log('info', 'position protected', { coin, side, size });
      continue;
    }

// Grace period: skip very-recently-opened positions — DECIDE may still be
    // mid-execution (open done, stop placement in flight). Avoids a redundant
    // recovery stop racing DECIDE's intended stop.
    const openedAt = await latestOpenFillTime(coin);
    if (openedAt && (Date.now() - openedAt) < GRACE_SECONDS * 1000) {
      log('info', 'naked but within grace — skipping this cycle', { coin, ageMs: Date.now() - openedAt, graceSeconds: GRACE_SECONDS });
      continue;
    }
    // NAKED POSITION — reconstruct a stop
    log('warn', 'NAKED POSITION detected — no resting stop', { coin, side, size });
    const mids = await hlPost({ type: 'allMids' });
    const px = parseFloat(mids[coin]);
    const stopPct = findOriginalStopPct(coin) ?? DEFAULT_STOP_PCT;
    const stopPx = side === 'long' ? px * (1 - stopPct / 100) : px * (1 + stopPct / 100);
    const closeSide = side === 'long' ? 'SELL' : 'BUY';

    const placed = await hl.placeTriggerOrder(HL_CONFIG, { coin, side: closeSide, size, triggerPx: stopPx, tpsl: 'sl', isMarket: true });
    if (placed.success) {
      log('warn', 'placed recovery stop on naked position', { coin, stopPx, stopPct, orderId: placed.orderId });
    } else {
      // Could not place stop — close the position rather than leave it naked
      log('error', 'recovery stop FAILED — closing naked position', { coin, error: placed.error });
      const closed = await hl.placePerpOrder(HL_CONFIG, { coin, side: closeSide, size, type: 'MARKET', reduceOnly: true });
      log('error', 'naked position closed', { coin, result: JSON.stringify(closed) });
    }
  }
}

async function loop() {
  log('info', 'watchdog started', { network: TESTNET ? 'testnet' : 'mainnet', pollSeconds: POLL_SECONDS, defaultStopPct: DEFAULT_STOP_PCT, dryRun: HL_CONFIG.dryRun });
  while (true) {
    try {
      await checkOnce();
    } catch (e: any) {
      log('error', 'watchdog check failed', { error: e.message });
    }
    await new Promise(r => setTimeout(r, POLL_SECONDS * 1000));
  }
}

loop();

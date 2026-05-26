import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, withdrawalsAllowed } from '../../src/skills/bundled/hyperliquid/index';

// _configLogged is module-level and guards log output only (not return values).
// Tests verify return values directly — logging side effects are intentionally not tested.

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

// 2a — agent mode: returns config with walletAddress=vaultAddress, privateKey=agentKey, vaultAddress set
test('agent mode: config has walletAddress=vaultAddress and privateKey=agentKey', () => {
  withEnv({
    HYPERLIQUID_AGENT_KEY: '0xdeadbeef',
    HYPERLIQUID_VAULT_ADDRESS: '0xmainwallet',
    HYPERLIQUID_PRIVATE_KEY: undefined,
    HYPERLIQUID_WALLET: undefined,
  }, () => {
    const cfg = getConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg!.walletAddress, '0xmainwallet');
    assert.equal(cfg!.privateKey, '0xdeadbeef');
    assert.equal(cfg!.vaultAddress, '0xmainwallet');
  });
});

// 2b — agent key without vault address → null (trading disabled)
test('agent mode: missing VAULT_ADDRESS returns null', () => {
  withEnv({
    HYPERLIQUID_AGENT_KEY: '0xdeadbeef',
    HYPERLIQUID_VAULT_ADDRESS: undefined,
    HYPERLIQUID_PRIVATE_KEY: undefined,
    HYPERLIQUID_WALLET: undefined,
  }, () => {
    const cfg = getConfig();
    assert.equal(cfg, null);
  });
});

// 2c — legacy main-wallet mode: returns config without vaultAddress
test('legacy mode: config has walletAddress=wallet, no vaultAddress', () => {
  withEnv({
    HYPERLIQUID_AGENT_KEY: undefined,
    HYPERLIQUID_VAULT_ADDRESS: undefined,
    HYPERLIQUID_PRIVATE_KEY: '0xprivkey',
    HYPERLIQUID_WALLET: '0xlegacywallet',
  }, () => {
    const cfg = getConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg!.walletAddress, '0xlegacywallet');
    assert.equal(cfg!.privateKey, '0xprivkey');
    assert.equal(cfg!.vaultAddress, undefined);
  });
});

// 2d — both modes set: agent mode wins
test('both modes set: agent mode takes precedence, vaultAddress is set', () => {
  withEnv({
    HYPERLIQUID_AGENT_KEY: '0xagentkey',
    HYPERLIQUID_VAULT_ADDRESS: '0xvault',
    HYPERLIQUID_PRIVATE_KEY: '0xlegacyprivkey',
    HYPERLIQUID_WALLET: '0xlegacywallet',
  }, () => {
    const cfg = getConfig();
    assert.ok(cfg !== null);
    // Must be agent config: walletAddress=vaultAddress, not legacy wallet
    assert.equal(cfg!.walletAddress, '0xvault');
    assert.equal(cfg!.privateKey, '0xagentkey');
    assert.equal(cfg!.vaultAddress, '0xvault');
    // Legacy key must NOT appear in the returned config
    assert.notEqual(cfg!.privateKey, '0xlegacyprivkey');
    assert.notEqual(cfg!.walletAddress, '0xlegacywallet');
  });
});

// 2e — nothing configured → null
test('not configured: null when no env vars set', () => {
  withEnv({
    HYPERLIQUID_AGENT_KEY: undefined,
    HYPERLIQUID_VAULT_ADDRESS: undefined,
    HYPERLIQUID_PRIVATE_KEY: undefined,
    HYPERLIQUID_WALLET: undefined,
  }, () => {
    const cfg = getConfig();
    assert.equal(cfg, null);
  });
});

// 2f — only WALLET set but no PRIVATE_KEY → null (legacy mode needs both)
test('legacy mode: only WALLET without PRIVATE_KEY returns null', () => {
  withEnv({
    HYPERLIQUID_AGENT_KEY: undefined,
    HYPERLIQUID_VAULT_ADDRESS: undefined,
    HYPERLIQUID_PRIVATE_KEY: undefined,
    HYPERLIQUID_WALLET: '0xwallet',
  }, () => {
    const cfg = getConfig();
    assert.equal(cfg, null);
  });
});

// withdrawalsAllowed tests

test('withdrawalsAllowed: false by default (env var unset)', () => {
  withEnv({ HYPERLIQUID_ALLOW_WITHDRAWALS: undefined }, () => {
    assert.equal(withdrawalsAllowed(), false);
  });
});

test('withdrawalsAllowed: true when set to "true"', () => {
  withEnv({ HYPERLIQUID_ALLOW_WITHDRAWALS: 'true' }, () => {
    assert.equal(withdrawalsAllowed(), true);
  });
});

test('withdrawalsAllowed: false when set to "false"', () => {
  withEnv({ HYPERLIQUID_ALLOW_WITHDRAWALS: 'false' }, () => {
    assert.equal(withdrawalsAllowed(), false);
  });
});

// LIMITATION: leverage=1 fallback when no existing position
// When a coin has no open position, fetchRiskContext returns leverage=1 regardless
// of the account-wide max leverage for that asset. This means the MAX_LEVERAGE
// ceiling is NOT enforced per-order for assets with no existing position — it is
// only enforced at explicit /hl leverage set-time.
// This test documents the current behavior. A future patch should fetch
// account-wide leverage via the /info endpoint to close this gap.
test('LIMITATION: getConfig does not enforce leverage ceiling on fresh positions', () => {
  // This test documents that getConfig() returns a config object without any
  // leverage information — the leverage ceiling gap for flat positions is in
  // fetchRiskContext (in index.ts), not in getConfig. The ceiling check in
  // checkOrderAgainstCeilings receives leverage=1 for flat positions, which
  // will always pass the leverage ceiling check even if the actual entry
  // leverage is higher.
  withEnv({
    HYPERLIQUID_AGENT_KEY: '0xagentkey',
    HYPERLIQUID_VAULT_ADDRESS: '0xvault',
    HYPERLIQUID_PRIVATE_KEY: undefined,
    HYPERLIQUID_WALLET: undefined,
  }, () => {
    const cfg = getConfig();
    assert.ok(cfg !== null);
    // Config carries no leverage field — leverage is looked up dynamically
    // from position state, defaulting to 1 when flat.
    assert.equal('leverage' in cfg!, false);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../src/trading/safety';

// Regression guard on DEFAULT_CONFIG values (Patch 2).
// If any of these fail, a change tightened or loosened a global safety floor —
// review intentionally before adjusting the expected values here.

test('DEFAULT_CONFIG: dailyLossLimit is $100', () => {
  assert.equal(DEFAULT_CONFIG.dailyLossLimit, 100);
});

test('DEFAULT_CONFIG: dailyLossLimitPct is 3%', () => {
  assert.equal(DEFAULT_CONFIG.dailyLossLimitPct, 3);
});

test('DEFAULT_CONFIG: maxDrawdownPct is 10%', () => {
  assert.equal(DEFAULT_CONFIG.maxDrawdownPct, 10);
});

test('DEFAULT_CONFIG: maxCorrelation is 0.8', () => {
  assert.equal(DEFAULT_CONFIG.maxCorrelation, 0.8);
});

test('DEFAULT_CONFIG: maxConcentrationPct is 20%', () => {
  assert.equal(DEFAULT_CONFIG.maxConcentrationPct, 20);
});

test('DEFAULT_CONFIG: maxSameDirectionPositions is 3', () => {
  assert.equal(DEFAULT_CONFIG.maxSameDirectionPositions, 3);
});

test('DEFAULT_CONFIG: cooldownMs is 4 hours', () => {
  assert.equal(DEFAULT_CONFIG.cooldownMs, 4 * 60 * 60 * 1000);
});

test('DEFAULT_CONFIG: autoCloseOnBreaker is true', () => {
  assert.equal(DEFAULT_CONFIG.autoCloseOnBreaker, true);
});

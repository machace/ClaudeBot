#!/usr/bin/env tsx
/**
 * One-shot agent wallet approval script.
 *
 * Run this ONCE from your laptop (never on the VPS) to register an agent wallet
 * on Hyperliquid. After approval, the agent wallet can trade on behalf of your
 * main wallet but CANNOT withdraw funds.
 *
 * Usage:
 *   HYPERLIQUID_MAIN_PRIVATE_KEY=0x... \
 *   HYPERLIQUID_AGENT_ADDRESS=0x... \
 *   npm run approve-agent
 *
 * Optional env vars:
 *   HYPERLIQUID_AGENT_NAME   Friendly name for the agent (default: "clodds-vps")
 *   HYPERLIQUID_TESTNET      Set to "true" for testnet (default: "false")
 */

import { Wallet } from 'ethers';
import { approveAgent, type HyperliquidConfig } from '../src/exchanges/hyperliquid/index.js';

async function main(): Promise<void> {
  const mainPrivateKey = process.env.HYPERLIQUID_MAIN_PRIVATE_KEY;
  const agentAddress = process.env.HYPERLIQUID_AGENT_ADDRESS;
  const agentName = process.env.HYPERLIQUID_AGENT_NAME ?? 'clodds-vps';
  const testnet = process.env.HYPERLIQUID_TESTNET === 'true';

  if (!mainPrivateKey) {
    console.error('Error: HYPERLIQUID_MAIN_PRIVATE_KEY is required.');
    console.error('  This is your MAIN wallet private key, used only for this one-shot approval.');
    console.error('  Do NOT copy this key to the VPS after running this script.');
    process.exit(1);
  }

  if (!agentAddress) {
    console.error('Error: HYPERLIQUID_AGENT_ADDRESS is required.');
    console.error('  Generate a fresh Ethereum keypair for the agent (e.g. `cast wallet new`)');
    console.error('  and provide the ADDRESS here (not the private key).');
    process.exit(1);
  }

  const mainWallet = new Wallet(mainPrivateKey);
  const mainAddress = mainWallet.address;

  console.log('');
  console.log('Hyperliquid agent wallet approval');
  console.log('==================================');
  console.log(`  Main wallet : ${mainAddress}`);
  console.log(`  Agent addr  : ${agentAddress}`);
  console.log(`  Agent name  : ${agentName}`);
  console.log(`  Network     : ${testnet ? 'testnet' : 'mainnet'}`);
  console.log('');
  console.log('Submitting approval transaction...');

  const config: HyperliquidConfig = {
    walletAddress: mainAddress,
    privateKey: mainPrivateKey,
    testnet,
  };

  const result = await approveAgent(config, agentAddress, agentName);

  if (!result.success) {
    console.error(`\nApproval failed: ${result.error}`);
    process.exit(1);
  }

  console.log('');
  console.log('Agent wallet approved successfully!');
  console.log('');
  console.log('Next: set these variables on the VPS (and ONLY these):');
  console.log('');
  console.log(`  HYPERLIQUID_AGENT_KEY=<agent wallet private key>`);
  console.log(`  HYPERLIQUID_VAULT_ADDRESS=${mainAddress}`);
  console.log('');
  console.log('IMPORTANT:');
  console.log('  - Do NOT put HYPERLIQUID_MAIN_PRIVATE_KEY on the VPS.');
  console.log('  - The agent wallet can trade but CANNOT withdraw funds.');
  console.log('  - Keep the main wallet key offline or in a hardware wallet.');
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

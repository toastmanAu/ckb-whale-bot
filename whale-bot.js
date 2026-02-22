#!/usr/bin/env node
/**
 * ckb-whale-bot — CKB Whale Alert Bot
 *
 * Monitors the local CKB node for transactions over 10M CKB.
 * Skips cellbase (tx[0] in every block) — watches real UTXO transfers only.
 * Sends alerts to the NervosUnofficial Telegram group.
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
//
// Config priority: environment variables > config.json > built-in defaults.
// BOT_TOKEN and CHAT_ID are required — the bot will exit if missing.
// Copy config.example.json → config.json and fill in your values.

const CONFIG_PATH = path.join(__dirname, 'config.json');
let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}

const CKB_RPC   = process.env.CKB_RPC    || fileConfig.ckb_rpc    || 'http://127.0.0.1:8114';
const BOT_TOKEN = process.env.BOT_TOKEN   || fileConfig.bot_token;
const CHAT_ID   = process.env.CHAT_ID     || fileConfig.chat_id;
const EXPLORER_TX = 'https://explorer.nervos.org/transaction';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('ERROR: BOT_TOKEN and CHAT_ID are required.');
  console.error('       Set them as env vars or in config.json (see config.example.json).');
  process.exit(1);
}

const SHANNON_PER_CKB    = 100_000_000n;  // 1 CKB = 1e8 shannons
const WHALE_USD_THRESHOLD = 200_000;      // alert if tx ≥ $200,000 USD

const POLL_INTERVAL_MS = 8_000;           // just under ~6s block time
const STATE_FILE       = path.join(__dirname, '.last-block');

// ── CKB Price (CoinGecko, cached 5 min) ──────────────────────────────────────

let ckbPriceUsd   = null;   // null until first fetch
let priceFetchedAt = 0;
const PRICE_TTL_MS = 5 * 60 * 1000;

async function fetchCkbPrice() {
  const now = Date.now();
  if (ckbPriceUsd !== null && (now - priceFetchedAt) < PRICE_TTL_MS) {
    return ckbPriceUsd;
  }
  try {
    const data = await request(
      'https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd'
    );
    const price = data?.['nervos-network']?.usd;
    if (typeof price === 'number' && price > 0) {
      ckbPriceUsd    = price;
      priceFetchedAt = now;
      console.log(`[price] CKB = $${price.toFixed(6)} USD`);
    }
  } catch (e) {
    console.warn(`[price] CoinGecko fetch failed: ${e.message}`);
  }
  return ckbPriceUsd;
}

// Returns the CKB (in shannons) equivalent of WHALE_USD_THRESHOLD at current price.
// Falls back to 10M CKB if price unavailable.
function whaleThresholdShannons(priceUsd) {
  if (!priceUsd || priceUsd <= 0) {
    return 10_000_000n * SHANNON_PER_CKB;  // fallback: 10M CKB
  }
  const ckbNeeded = Math.ceil(WHALE_USD_THRESHOLD / priceUsd);
  return BigInt(ckbNeeded) * SHANNON_PER_CKB;
}

// ── State ────────────────────────────────────────────────────────────────────

let lastBlock = loadLastBlock();
let running   = true;

function loadLastBlock() {
  try {
    const saved = fs.readFileSync(STATE_FILE, 'utf8').trim();
    const n = parseInt(saved, 10);
    if (!isNaN(n) && n > 0) {
      console.log(`[state] Resuming from block ${n}`);
      return n;
    }
  } catch (_) {}
  return null;
}

function saveLastBlock(n) {
  fs.writeFileSync(STATE_FILE, String(n), 'utf8');
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function request(url, body) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const mod     = isHttps ? https : http;
    const opts    = new URL(url);

    const req = mod.request(
      {
        hostname : opts.hostname,
        port     : opts.port || (isHttps ? 443 : 80),
        path     : opts.pathname + (opts.search || ''),
        method   : body ? 'POST' : 'GET',
        headers  : {
          'Content-Type'   : 'application/json',
          'Content-Length' : body ? Buffer.byteLength(body) : 0,
        },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 200)}`)); }
        });
      }
    );

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

function ckbRpc(method, params = []) {
  return request(
    CKB_RPC,
    JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
  ).then((r) => {
    if (r.error) throw new Error(`RPC ${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  });
}

function sendTelegram(text) {
  const body = JSON.stringify({
    chat_id    : CHAT_ID,
    text,
    parse_mode : 'HTML',
    disable_web_page_preview: true,
  });
  return request(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    body
  ).then((r) => {
    if (!r.ok) throw new Error(`Telegram error: ${JSON.stringify(r)}`);
    return r;
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatCKB(shannons) {
  const ckb = shannons / SHANNON_PER_CKB;
  return ckb.toLocaleString('en-AU');
}

function formatMillions(shannons) {
  const m = Number(shannons / (SHANNON_PER_CKB * 1_000_000n));
  return m.toFixed(2) + 'M';
}

function truncHash(hash, len = 12) {
  return hash.slice(0, 2 + len) + '...' + hash.slice(-6);
}

function buildAlert({ hash, blockNum, outputCKB, inputCount, outputCount, outputs, priceUsd }) {
  const ckbAmount  = formatCKB(outputCKB);
  const millAmount = formatMillions(outputCKB);

  // Largest single output
  const biggest = outputs.reduce((a, b) => (b > a ? b : a), 0n);

  // USD value
  let usdLine = '';
  if (priceUsd && priceUsd > 0) {
    const ckbCount  = Number(outputCKB / SHANNON_PER_CKB);
    const usdValue  = ckbCount * priceUsd;
    const usdStr    = usdValue >= 1_000_000
      ? `$${(usdValue / 1_000_000).toFixed(2)}M`
      : `$${Math.round(usdValue).toLocaleString('en-AU')}`;
    usdLine = `💵 USD value: <code>~${usdStr}</code> @ $${priceUsd.toFixed(4)}/CKB\n`;
  }

  return [
    `🐋 <b>CKB Whale Alert</b>`,
    ``,
    `<b>${millAmount} CKB</b> moved on-chain`,
    ``,
    `💰 Total output: <code>${ckbAmount} CKB</code>`,
    usdLine.trimEnd(),
    `📦 Largest output: <code>${formatCKB(biggest)} CKB</code>`,
    `🔀 Inputs → Outputs: ${inputCount} → ${outputCount}`,
    `📏 Block: <code>${blockNum.toLocaleString('en-AU')}</code>`,
    ``,
    `🔗 <a href="${EXPLORER_TX}/${hash}">${truncHash(hash)}</a>`,
  ].filter(l => l !== '').join('\n');
}

// ── Self-transfer detection ──────────────────────────────────────────────────
//
// A "change" / self-transfer tx has all outputs going back to addresses that
// were already represented in the inputs. We fetch the previous output for
// each input, collect their lock scripts, then check whether every output
// lock script is already in that set.  If yes → skip.
//
// Returns true if the tx is a self-transfer (same sender/receiver).

async function isSelfTransfer(tx) {
  try {
    // Batch-fetch all input previous transactions in parallel
    const prevTxResults = await Promise.all(
      tx.inputs.map((inp) => ckbRpc('get_transaction', [inp.previous_output.tx_hash]))
    );

    const inputLocks = new Set();
    for (let j = 0; j < tx.inputs.length; j++) {
      const res = prevTxResults[j];
      if (!res) continue;
      const idx  = parseInt(tx.inputs[j].previous_output.index, 16);
      const lock = res.transaction?.outputs?.[idx]?.lock;
      if (lock) inputLocks.add(JSON.stringify(lock));
    }

    if (inputLocks.size === 0) return false; // couldn't resolve — don't filter

    // If every output lock appears in the input lock set → self-transfer
    return tx.outputs.every((o) => inputLocks.has(JSON.stringify(o.lock)));
  } catch (err) {
    console.warn(`[filter] Could not resolve inputs for ${truncHash(tx.hash)}: ${err.message}`);
    return false; // on error, err on the side of alerting
  }
}

// ── Block processing ─────────────────────────────────────────────────────────

async function processBlock(blockNum) {
  const block = await ckbRpc('get_block_by_number', [
    '0x' + blockNum.toString(16),
  ]);

  if (!block) return;

  const txs = block.transactions;

  // Fetch current price once per block (cached 5 min)
  const priceUsd = await fetchCkbPrice();
  const threshold = whaleThresholdShannons(priceUsd);

  const threshCkb = Number(threshold / SHANNON_PER_CKB).toLocaleString('en-AU');
  const threshUsd = priceUsd
    ? ` (~$${WHALE_USD_THRESHOLD.toLocaleString('en-AU')} USD @ $${priceUsd.toFixed(4)}/CKB)`
    : ' (price unavailable, using 10M CKB fallback)';

  // tx[0] is always the cellbase (miner reward) — skip it
  for (let i = 1; i < txs.length; i++) {
    const tx = txs[i];

    const outputs = tx.outputs.map((o) => BigInt(o.capacity));
    const total   = outputs.reduce((a, b) => a + b, 0n);

    if (total < threshold) continue;

    // Filter self-transfers (change-only / consolidation txs)
    if (await isSelfTransfer(tx)) {
      console.log(`[skip] Self-transfer  block=${blockNum}  tx=${truncHash(tx.hash)}  ${formatCKB(total)} CKB`);
      continue;
    }

    const msg = buildAlert({
      hash       : tx.hash,
      blockNum,
      outputCKB  : total,
      inputCount : tx.inputs.length,
      outputCount: tx.outputs.length,
      outputs,
      priceUsd,
    });

    console.log(`\n🐋 WHALE  block=${blockNum}  tx=${tx.hash}  ${formatCKB(total)} CKB${threshUsd}`);

    try {
      await sendTelegram(msg);
      console.log('   ✓ Alert sent to Telegram');
    } catch (err) {
      console.error('   ✗ Telegram send failed:', err.message);
    }

    // Brief delay between multiple alerts in same block
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── Main polling loop ─────────────────────────────────────────────────────────

async function poll() {
  try {
    const tipHex = await ckbRpc('get_tip_block_number');
    const tip    = parseInt(tipHex, 16);

    if (lastBlock === null) {
      // First run — start from current tip, don't replay history
      lastBlock = tip;
      saveLastBlock(lastBlock);
      console.log(`[init] Starting at tip block ${tip}`);
      return;
    }

    if (tip <= lastBlock) return; // nothing new yet

    const toProcess = Math.min(tip, lastBlock + 50); // catch up max 50 blocks at a time

    for (let n = lastBlock + 1; n <= toProcess; n++) {
      await processBlock(n);
      lastBlock = n;
      saveLastBlock(n);
    }

    if (tip > toProcess) {
      console.log(`[poll] Catching up: processed ${toProcess}, tip=${tip}`);
    }

  } catch (err) {
    console.error(`[poll] Error: ${err.message}`);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log('🐋 CKB Whale Alert Bot starting...');
console.log(`   Node  : ${CKB_RPC}`);
console.log(`   Chat  : ${CHAT_ID} (@NervosUnofficial)`);
console.log(`   Thresh: $${WHALE_USD_THRESHOLD.toLocaleString('en-AU')} USD (CKB equiv fetched live from CoinGecko)`);
console.log(`   Poll  : every ${POLL_INTERVAL_MS / 1000}s`);
console.log('');

// Send startup notification (once)
sendTelegram(
  `🐋 <b>CKB Whale Alert Bot online</b>\n` +
  `Monitoring transactions ≥ $${WHALE_USD_THRESHOLD.toLocaleString('en-AU')} USD in CKB\n` +
  `<i>Threshold auto-adjusts with live CKB price (CoinGecko)</i>`
).then(() => console.log('[startup] Telegram ping sent'))
  .catch((e) => console.error('[startup] Telegram ping failed:', e.message));

// Run immediately then on interval
poll();
const interval = setInterval(poll, POLL_INTERVAL_MS);

// Graceful shutdown
process.on('SIGTERM', () => { running = false; clearInterval(interval); console.log('Shutting down.'); });
process.on('SIGINT',  () => { running = false; clearInterval(interval); console.log('Shutting down.'); process.exit(0); });

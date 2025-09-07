#!/usr/bin/env ts-node

/**
 * pump_merged.ts
 * One file to:
 *  - (optional) create a new Pump.fun token (name/symbol/uri)
 *  - buy with SOL cap (not token amount)
 *  - listen for external "Buy" events on your mint and auto-sell proportionally
 *  - apply profit guard: sell only if estimated PnL >= +2% (configurable)
 *  - throttle to 1 sell per slot, CU bump, no Jito
 */

import fs from "fs";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  Transaction,
  ParsedInstruction,
  PartiallyDecodedInstruction,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@project-serum/anchor";
import { BN, Program, AnchorProvider, Wallet } from "@project-serum/anchor";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// -------------------- CONSTANTS -------------------- //

const DEFAULT_RPC = "https://mainnet.helius-rpc.com/?api-key=058fbdd6-e88b-4b6e-8c7c-475975643524";
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_ACCOUNT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// -------------------- CLI -------------------- //

const argv = yargs(hideBin(process.argv))
  // core
  .option("rpc", { type: "string", default: DEFAULT_RPC, describe: "RPC endpoint" })
  .option("mint", { type: "string", describe: "Target mint. If omitted, use --create or --watch-creations." })
  .option("buy", { type: "boolean", default: false, describe: "Perform an initial buy before listening" })
  .option("sol", { type: "number", default: 0, describe: "SOL to spend on initial buy (e.g., 0.25). Requires --buy." })
  .option("auto", { type: "boolean", default: true, describe: "Enable auto-sell listener" })

  // creation
  .option("create", { type: "boolean", default: false, describe: "Create a new Pump.fun token before buying" })
  .option("name", { type: "string", describe: "Token name (for --create)" })
  .option("symbol", { type: "string", describe: "Token symbol (for --create)" })
  .option("uri", { type: "string", describe: "Metadata URI (for --create)" })

  // sniper-style discovery (optional, unchanged)
  .option("watch-creations", { type: "boolean", default: false, describe: "If true and --mint is missing, pick your latest creation" })
  .option("scan-limit", { type: "number", default: 30, describe: "How many history txs to scan when --watch-creations" })

  // auto-sell policy
  .option("min_profit_bps", { type: "number", default: 200, describe: "Min profit bps to allow a sell (200 = 2%)" })

  // CU / priority fee (no Jito)
  .option("cu_limit", { type: "number", default: 600_000, describe: "Compute unit limit" })
  .option("cu_price", { type: "number", default: 2500, describe: "μLamports per CU (priority fee); 0 = none" })

  .option("verbose", { type: "boolean", default: true, describe: "Verbose logs" })
  .argv as any;

// -------------------- Wallet / Program -------------------- //

const KEYPAIR = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/my-solana-wallet.json`, "utf-8")))
);
const WALLET = KEYPAIR.publicKey;

const connection = new Connection(argv.rpc, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(KEYPAIR), { commitment: "confirmed" });
anchor.setProvider(provider);

const idl = JSON.parse(fs.readFileSync("./pump.json", "utf-8"));
// keep your previous workaround (disable events in IDL)
const pumpProgram = new Program({ ...idl, events: [] } as anchor.Idl, PUMP_PROGRAM_ID, provider);

// -------------------- Helpers -------------------- //

type PumpAccounts = Awaited<ReturnType<typeof getPumpAccounts>>;

async function getPumpAccounts(mint: PublicKey, user: PublicKey, program: Program, conn: Connection) {
  const [global] = await PublicKey.findProgramAddress([Buffer.from("global")], PUMP_PROGRAM_ID);
  const [bondingCurve] = await PublicKey.findProgramAddress([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const [pool] = await PublicKey.findProgramAddress([Buffer.from("pool"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const [eventAuthority] = await PublicKey.findProgramAddress([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);

  const baseMint = mint;
  const quoteMint = new PublicKey("11111111111111111111111111111111");
  const userBaseTokenAccount = await getAssociatedTokenAddress(baseMint, user);
  const userQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, user);
  const poolBaseTokenAccount = await getAssociatedTokenAddress(baseMint, pool, true);
  const poolQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, pool, true);
  const protocolFeeRecipientTokenAccount = await getAssociatedTokenAddress(quoteMint, FEE_ACCOUNT, true);

  const bcAcc = await program.account.bondingCurve.fetch(bondingCurve);
  if (!bcAcc) throw new Error(`Could not fetch bondingCurve at ${bondingCurve.toBase58()}`);

  let creator: PublicKey = user;
  try {
    // optional, safe to ignore failures
    // (not strictly required for buy/sell accounts)
  } catch {}

  const [creatorVault] = await PublicKey.findProgramAddress(
    [Buffer.from("creator-vault"), creator.toBuffer(), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const coinCreatorVaultAta = await getAssociatedTokenAddress(baseMint, creator, true);
  const coinCreatorVaultAuthority = creator;
  const associatedBondingCurve = await getAssociatedTokenAddress(
    baseMint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return {
    pool,
    user,
    global,
    baseMint,
    quoteMint,
    userBaseTokenAccount,
    userQuoteTokenAccount,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    protocolFeeRecipient: FEE_ACCOUNT,
    protocolFeeRecipientTokenAccount,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    eventAuthority,
    program: PUMP_PROGRAM_ID,
    coinCreatorVaultAta,
    coinCreatorVaultAuthority,
    bondingCurve,
    associatedBondingCurve,
    associatedUser: userBaseTokenAccount,
    creatorVault,
    creator,
  };
}

async function ensureUserATA(mint: PublicKey, owner: PublicKey, payer: PublicKey, ixs: anchor.web3.TransactionInstruction[]) {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        payer,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  return ata;
}

// -------------------- Position State -------------------- //

const state = {
  pos: {
    initialSolIn: 0,
    tokensHeld: 0n,
    avgEntrySolPerToken: null as number | null,
    lastSellSlot: null as number | null,
    realizedSol: 0,
  },
  cfg: {
    minProfitBps: Number(argv.min_profit_bps) || 200,
    cuLimit: Number(argv.cu_limit) || 600_000,
    cuPrice: Number(argv.cu_price) || 2500,
    verbose: !!argv.verbose,
  }
};

// -------------------- Utils -------------------- //

const lamports = (sol: number) => Math.floor(sol * LAMPORTS_PER_SOL);
const fmt = (n: number) => Number(n.toFixed(6));

function fractionToSell(buyerSol: number, myInitialSol: number): number {
  if (buyerSol >= 5 * myInitialSol) return 0.5; // ≥5x => 50%
  const f = buyerSol / myInitialSol;
  // buyer == 1x => f==1 -> sell 100%
  return Math.min(Math.max(f, 0), 1);
}

// -------------------- CREATE (from your snippet) -------------------- //

async function createPumpToken(name: string, symbol: string, uri: string): Promise<PublicKey> {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const [mintAuthorityPda] = await PublicKey.findProgramAddress(
    [Buffer.from("mint-authority")],
    PUMP_PROGRAM_ID
  );
  const [bondingCurvePda] = await PublicKey.findProgramAddress(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const bondingVaultAta = await getAssociatedTokenAddress(mint, bondingCurvePda, true);

  const [globalStatePda] = await PublicKey.findProgramAddress([Buffer.from("global")], PUMP_PROGRAM_ID);

  const [metadataPda] = await PublicKey.findProgramAddress(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  const [eventAuthorityPda] = await PublicKey.findProgramAddress([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);

  const ixs: anchor.web3.TransactionInstruction[] = [];
  if (state.cfg.cuPrice > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: state.cfg.cuPrice }));
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: state.cfg.cuLimit }));

  // Build the exact create() call you shared
  const createIx = await pumpProgram.methods
    .create(name, symbol, uri, WALLET)
    .accounts({
      mint,
      mintAuthority: mintAuthorityPda,
      bondingCurve: bondingCurvePda,
      associatedBondingCurve: bondingVaultAta,
      global: globalStatePda,
      mplTokenMetadata: TOKEN_METADATA_PROGRAM_ID,
      metadata: metadataPda,
      user: WALLET,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,                // legacy SPL token program
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      eventAuthority: eventAuthorityPda,
      program: PUMP_PROGRAM_ID,
    })
    .instruction();

  ixs.push(createIx);

  const tx = new Transaction().add(...ixs);
  tx.feePayer = WALLET;

  const sig = await sendAndConfirmTransaction(connection, tx, [KEYPAIR, mintKeypair], { commitment: "confirmed" });
  console.log(`🎯 Created token mint: ${mint.toBase58()} (tx: ${sig})`);
  console.log(`🔗 Pump.fun page: https://pump.fun/${mint.toBase58()}`);

  return mint;
}

// -------------------- BUY (SOL cap) -------------------- //

async function buildAndSendBuy_SOLCap(mint: PublicKey, solToSpend: number) {
  const accounts = await getPumpAccounts(mint, WALLET, pumpProgram, connection);
  const globalState = await pumpProgram.account.global.fetch(accounts.global);

  const maxSolCost = new BN(lamports(solToSpend));
  const amount = new BN(1); // Pump.fun buy semantics (amount is not the SOL; maxSolCost caps the SOL spend)

  const ixs: anchor.web3.TransactionInstruction[] = [];
  if (state.cfg.cuPrice > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: state.cfg.cuPrice }));
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: state.cfg.cuLimit }));

  await ensureUserATA(mint, WALLET, WALLET, ixs);

  const buyIx = await pumpProgram.methods.buy(amount, maxSolCost).accounts({
    global: accounts.global,
    feeRecipient: (globalState as any).feeRecipient,
    mint: accounts.baseMint,
    bondingCurve: accounts.bondingCurve,
    associatedBondingCurve: accounts.associatedBondingCurve,
    associatedUser: accounts.associatedUser,
    user: WALLET,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    creatorVault: accounts.creatorVault,
    coinCreatorVaultAta: accounts.coinCreatorVaultAta,
    coinCreatorVaultAuthority: accounts.coinCreatorVaultAuthority,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    eventAuthority: accounts.eventAuthority,
    program: PUMP_PROGRAM_ID,
  }).instruction();

  ixs.push(buyIx);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = WALLET;
  const sig = await sendAndConfirmTransaction(connection, tx, [KEYPAIR], { commitment: "confirmed" });
  console.log(`✅ BUY ${fmt(solToSpend)} SOL → ${sig}`);

  // Refresh post-buy token balance to set position
  const ata = await getAssociatedTokenAddress(mint, WALLET);
  const acct = await getAccount(connection, ata);
  state.pos.tokensHeld = BigInt(acct.amount.toString());
  state.pos.initialSolIn = solToSpend;
  if (state.pos.tokensHeld > 0n) {
    state.pos.avgEntrySolPerToken = state.pos.initialSolIn / Number(state.pos.tokensHeld);
  }
}

// -------------------- SELL -------------------- //

async function buildAndSendSell(mint: PublicKey, rawTokenAmount: bigint) {
  if (rawTokenAmount <= 0n) return;
  const accounts = await getPumpAccounts(mint, WALLET, pumpProgram, connection);

  const ixs: anchor.web3.TransactionInstruction[] = [];
  if (state.cfg.cuPrice > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: state.cfg.cuPrice }));
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: state.cfg.cuLimit }));

  const minSolOutput = new BN(0); // you said slippage doesn't matter
  const sellIx = await pumpProgram.methods
    .sell(new BN(rawTokenAmount.toString()), minSolOutput)
    .accounts(accounts)
    .instruction();

  ixs.push(sellIx);

  const tx = new Transaction().add(...ixs);
  tx.feePayer = WALLET;
  const sig = await sendAndConfirmTransaction(connection, tx, [KEYPAIR], { commitment: "confirmed" });
  console.log(`💸 SELL ${rawTokenAmount.toString()} tokens → ${sig}`);
}

// -------------------- Profit Guard (simple) -------------------- //

async function tryQuoteSellSOL(_mint: PublicKey, _tokenAmount: bigint): Promise<number | null> {
  // Placeholder (no simulation path). We’ll use last observed price from logs if present.
  return null;
}

// -------------------- Buy Event Parser -------------------- //

type BuyEvent = { mint: string; buyerSol: number; priceSolPerToken?: number };

function parseBuyEventFromLogs(logs: string[]): BuyEvent | null {
  const line = logs.find((l) => l.includes("Program log:") && /Buy/i.test(l));
  if (!line) return null;

  const mintMatch = line.match(/mint=([1-9A-HJ-NP-Za-km-z]{32,44})/);
  const solMatch = line.match(/buyer[_ ]?sol=([0-9.]+)/i);
  const priceMatch = line.match(/price=([0-9.]+)/i);

  if (!mintMatch || !solMatch) return null;
  return {
    mint: mintMatch[1],
    buyerSol: Number(solMatch[1]),
    priceSolPerToken: priceMatch ? Number(priceMatch[1]) : undefined,
  };
}

// -------------------- Auto-sell Engine -------------------- //

async function maybeAutoSell(mint: PublicKey, slot: number, buyerSol: number, lastPrice?: number) {
  if (state.pos.tokensHeld <= 0n || state.pos.initialSolIn <= 0) return;
  if (state.pos.lastSellSlot === slot) return;

  const frac = fractionToSell(buyerSol, state.pos.initialSolIn);
  if (frac <= 0) return;

  const toSell = BigInt(Math.floor(Number(state.pos.tokensHeld) * frac));
  if (toSell < 1n) return;

  let estSolOut: number | null = await tryQuoteSellSOL(mint, toSell);
  if (!estSolOut && lastPrice && state.pos.avgEntrySolPerToken) {
    estSolOut = Number(toSell) * lastPrice * 0.985; // small haircut
  }

  if (estSolOut && state.pos.avgEntrySolPerToken) {
    const estEntry = Number(toSell) * state.pos.avgEntrySolPerToken;
    const pnl = (estSolOut - estEntry) / Math.max(estEntry, 1e-12);
    const pnlBps = Math.floor(pnl * 10_000);
    if (pnlBps < state.cfg.minProfitBps) {
      if (state.cfg.verbose) {
        console.log(`🟨 slot ${slot}: buyer=${fmt(buyerSol)} SOL → proposed sell ${fmt(frac * 100)}% but est PnL ${pnlBps}bps < ${state.cfg.minProfitBps}bps. Skip.`);
      }
      return;
    }
  } else {
    if (state.cfg.verbose) console.log(`🟨 slot ${slot}: no reliable quote for ≥${state.cfg.minProfitBps}bps; skipping sell.`);
    return;
  }

  await buildAndSendSell(mint, toSell);
  state.pos.tokensHeld -= toSell;
  state.pos.lastSellSlot = slot;
}

// -------------------- Program Logs Subscription -------------------- //

function subscribeBuyEvents(mint: PublicKey) {
  const subId = connection.onLogs(
    PUMP_PROGRAM_ID,
    async (res) => {
      try {
        const ev = parseBuyEventFromLogs(res.logs || []);
        if (!ev || ev.mint !== mint.toBase58()) return;

        console.log(`🔔 Buy detected @slot ${res.slot}: ${fmt(ev.buyerSol)} SOL on mint ${ev.mint}`);
        await maybeAutoSell(mint, res.slot, ev.buyerSol, ev.priceSolPerToken);
      } catch (e) {
        console.error("onLogs handler error:", e);
      }
    },
    "confirmed"
  );
  console.log(`👂 Listening for Buy events on ${mint.toBase58()} (subId=${subId})`);
  return subId;
}

// -------------------- Optional: scan your creations (unchanged) -------------------- //

function extractAccounts(ix: ParsedInstruction | PartiallyDecodedInstruction): string[] {
  if ("accounts" in ix && (ix as any).accounts) {
    return (ix as any).accounts.map((a: any) => (typeof a === "string" ? a : a?.toBase58?.() || String(a)));
  }
  return [];
}

async function getPumpCreations(conn: Connection, wallet: PublicKey, limit: number) {
  const signatures = await conn.getSignaturesForAddress(wallet, { limit });
  const results: any[] = [];

  for (const { signature, blockTime } of signatures) {
    const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;

    for (const ix of tx.transaction.message.instructions as (ParsedInstruction | PartiallyDecodedInstruction)[]) {
      const progId = (ix as any).programId?.toBase58?.() || (ix as any).programId || "";
      if (progId === PUMP_PROGRAM_ID.toBase58()) {
        const accounts = extractAccounts(ix);
        results.push({ signature, mint: accounts[0] || "", pool: accounts[0] || "", blockTime: blockTime || 0, foundIn: "top-level", allAccounts: accounts });
      }
    }

    if (tx.meta?.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions as (ParsedInstruction | PartiallyDecodedInstruction)[]) {
          const progId = (ix as any).programId?.toBase58?.() || (ix as any).programId || "";
          if (progId === PUMP_PROGRAM_ID.toBase58()) {
            const accounts = extractAccounts(ix);
            results.push({ signature, mint: accounts[0] || "", pool: accounts[0] || "", blockTime: blockTime || 0, foundIn: "inner", allAccounts: accounts });
          }
        }
      }
    }
  }
  return results;
}

// -------------------- MAIN -------------------- //

(async () => {
  console.log(`👤 Wallet: ${WALLET.toBase58()}`);
  console.log(`🔗 RPC: ${argv.rpc}`);
  console.log(`⚙️ CU: limit=${state.cfg.cuLimit}, price=${state.cfg.cuPrice} μLamports`);
  console.log(`🔧 Profit guard: >= ${state.cfg.minProfitBps} bps`);

  let targetMint: PublicKey | null = argv.mint ? new PublicKey(argv.mint) : null;

  // 1) Optional: create a token first (uses your create() logic)
  if (argv.create) {
    if (!argv.name || !argv.symbol || !argv.uri) {
      throw new Error("For --create you must provide --name, --symbol, and --uri");
    }
    targetMint = await createPumpToken(argv.name, argv.symbol, argv.uri);
  }

  // 2) Optional: discover your latest creation if no mint provided
  if (!targetMint && argv.watch_creations) {
    const items = await getPumpCreations(connection, WALLET, Math.max(argv.scan_limit ?? 30, 30));
    if (items.length && items[0].mint) {
      targetMint = new PublicKey(items[0].mint);
      console.log(`🆕 Latest created mint detected: ${targetMint.toBase58()}`);
    } else {
      console.log("No recent Pump.fun creations found for your wallet.");
    }
  }

  if (!targetMint) {
    console.log("No target mint. Provide --mint, or use --create, or --watch-creations.");
    return;
  }

  // 3) Optional: initial buy in SOL
  if (argv.buy) {
    const solToSpend = Number(argv.sol);
    if (!(solToSpend > 0)) throw new Error("--sol must be > 0 with --buy");
    await buildAndSendBuy_SOLCap(targetMint, solToSpend);
  } else {
    // if you already hold tokens, prime position
    try {
      const ata = await getAssociatedTokenAddress(targetMint, WALLET);
      const acct = await getAccount(connection, ata);
      state.pos.tokensHeld = BigInt(acct.amount.toString());
      console.log(`📦 Position (pre-existing): tokensHeld=${state.pos.tokensHeld.toString()}`);
    } catch {
      console.log("ℹ️ No tokens currently held (or ATA missing).");
    }
  }

  // 4) Auto-sell listener
  if (argv.auto) {
    subscribeBuyEvents(targetMint);
  } else {
    console.log("ℹ️ Auto-sell listener disabled (--auto=false).");
  }

  console.log("🏁 Running. CTRL+C to exit.");
})().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});

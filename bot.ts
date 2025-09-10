#!/usr/bin/env ts-node

/**
 * pump_merged.ts — merged working logic
 *
 * - Imports fixed (SPL token helpers, yargs helpers)
 * - Buy/Sell wired via Anchor program methods (from sniper-bot.ts), including feeRecipient
 * - Slot-based auto-sell after N blocks (from both buy-from-pump/sniper-bot)
 * - Optional direct-discriminator build path preserved behind a toggle
 *
 * Required local file: ./pump.json (IDL)
 * Required wallet:  ~/my-solana-wallet.json (or override with --kp)
 */

import fs from "fs";
import path from "path";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  Transaction,
  Logs,
} from "@solana/web3.js";

import {
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { Metaplex } from "@metaplex-foundation/js";
import * as anchor from "@project-serum/anchor";
import { BN, Program, AnchorProvider, Wallet } from "@project-serum/anchor";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

/* ----------------------------- CLI ARGUMENTS ----------------------------- */

const argv = yargs(hideBin(process.argv))
  .scriptName("pump_merged")
  .option("rpc", { type: "string", demandOption: true, desc: "RPC endpoint" })
  .option("kp", { type: "string", default: "~/my-solana-wallet.json", desc: "Keypair JSON path" })
  .option("mint", { type: "string", desc: "Target token mint (base mint)" })
  .option("buy", { type: "boolean", default: false, desc: "Execute an initial buy" })
  .option("sol", { type: "number", default: 0, desc: "SOL amount to spend on buy" })
  .option("auto", { type: "boolean", default: false, desc: "Enable auto-sell after SLOT_WAIT blocks" })
  .option("blocks", { type: "number", default: 10, desc: "Blocks to wait before auto-sell" })
  .option("limit", { type: "number", default: 30, desc: "How many historical txs to check (unused here)" })
  .help()
  .parseSync();

/* ------------------------------ CONSTANTS -------------------------------- */

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_ACCOUNT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");

// Optionally use the “raw discriminator” build path from buy-from-pump.ts
// Set to true to use raw instructions; false = Anchor methods (default).
const USE_RAW_DISCRIMINATOR_BUILD = false;

// Discriminators + constants (for raw build path)
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const RAW_GLOBAL_PDA = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID)[0];
const RAW_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID)[0];
const CREATOR_VAULT_FALLBACK = new PublicKey("FywGmh1itGfrGWnBhTCnnGeWLppMUEe9QZTrDj73SVum");

// IDL (required for Anchor path)
const idl = JSON.parse(fs.readFileSync("./pump.json", "utf-8"));
const minimalIdl = { ...idl, events: [] }; // disable event decoding

/* ------------------------------ UTIL HELPERS ----------------------------- */

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(process.env.HOME || "", p.slice(2)) : p;
}

function loadKeypair(filePath: string): Keypair {
  const full = expandHome(filePath);
  const raw = JSON.parse(fs.readFileSync(full, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function fmtLamports(lamports: number | bigint) {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6) + " SOL";
}

const connection = new Connection(argv.rpc, { commitment: "confirmed" });
const KEYPAIR = loadKeypair(argv.kp);
const WALLET = KEYPAIR.publicKey;

/* ------------------------- SPL / ATA Helper (Sync) ----------------------- */

async function ensureAta(owner: PublicKey, mint: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const ix = createAssociatedTokenAccountInstruction(
    WALLET, // payer
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  // Optimistic create: it's fine if already exists
  return { ata, ixMaybe: ix };
}

/* ------------------------- ANCHOR: PROGRAM/PROVIDER ---------------------- */

const provider = new AnchorProvider(connection, new Wallet(KEYPAIR), { commitment: "confirmed" });
anchor.setProvider(provider);
const pumpProgram = new Program(minimalIdl as anchor.Idl, PUMP_PROGRAM_ID, provider);

/* --------------------------- ACCOUNT DERIVATIONS ------------------------- */

async function getPumpAccounts(mint: PublicKey, user: PublicKey) {
  const [global] = await PublicKey.findProgramAddress([Buffer.from("global")], PUMP_PROGRAM_ID);
  const [bondingCurve] = await PublicKey.findProgramAddress([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const [pool] = await PublicKey.findProgramAddress([Buffer.from("pool"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const [eventAuthority] = await PublicKey.findProgramAddress([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);

  const baseMint = mint;
  const quoteMint = new PublicKey("11111111111111111111111111111111"); // SOL token (native)
  const userBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const poolBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, pool, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const poolQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, pool, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(quoteMint, FEE_ACCOUNT, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // Ensure bondingCurve exists per your code
  const bondingCurveAcc = await pumpProgram.account.bondingCurve.fetch(bondingCurve);
  if (!bondingCurveAcc) throw new Error(`Could not fetch bondingCurve at ${bondingCurve.toBase58()}`);

  // Derive creator (try metadata updateAuthority; fallback to wallet)
  let creator: PublicKey = user;
  try {
    const metaplex = Metaplex.make(connection);
    const nft = await metaplex.nfts().findByMint({ mintAddress: mint });
    const ua = (nft as any)?.updateAuthorityAddress;
    if (ua) creator = ua as PublicKey;
  } catch {
    // ignore metadata failures
  }

  const [creatorVault] = await PublicKey.findProgramAddress(
    [Buffer.from("creator-vault"), creator.toBuffer(), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const coinCreatorVaultAta = getAssociatedTokenAddressSync(baseMint, creator, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const coinCreatorVaultAuthority = creator;
  const associatedBondingCurve = getAssociatedTokenAddressSync(baseMint, bondingCurve, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

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

/* ------------------------------ BUY / SELL ------------------------------- */

/** Anchor-path BUY (from sniper-bot.ts) */
async function ixBuyPump_Anchor(mint: PublicKey, lamportsIn: number) {
  const accounts = await getPumpAccounts(mint, WALLET);
  const globalState = await pumpProgram.account.global.fetch(accounts.global);
  const amount = new BN(1);
  const maxSolCost = new BN(lamportsIn);

  const ixs: anchor.web3.TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
  ];

  // Ensure ATA exists
  const ataInfo = await connection.getAccountInfo(accounts.associatedUser);
  if (!ataInfo) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        WALLET,
        accounts.associatedUser,
        WALLET,
        accounts.baseMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const buyIx = await pumpProgram.methods
    .buy(amount, maxSolCost)
    .accounts({
      global: accounts.global,
      feeRecipient: (globalState as any).feeRecipient, // CRUCIAL
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
    })
    .instruction();

  ixs.push(buyIx);
  return { ixs, signers: [] as Keypair[], amountBought: new BN(1) };
}

/** Anchor-path SELL (from sniper-bot.ts) */
async function ixSellPump_Anchor(mint: PublicKey, amount: BN) {
  const accounts = await getPumpAccounts(mint, WALLET);
  const minSolOutput = new BN(0);

  const ixs: anchor.web3.TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
  ];

  const sellIx = await pumpProgram.methods
    .sell(amount, minSolOutput)
    .accounts(accounts as any)
    .instruction();

  ixs.push(sellIx);
  return { ixs, signers: [] as Keypair[] };
}

/** RAW discriminator BUY (from buy-from-pump.ts) */
async function ixBuyPump_Raw(mint: PublicKey, curve: PublicKey, associatedBondingCurve: PublicKey, lamportsIn: number) {
  // Build data
  const amount = new BN(1);
  const maxSolCost = new BN(lamportsIn);
  const data = Buffer.alloc(BUY_DISCRIMINATOR.length + 16);
  BUY_DISCRIMINATOR.copy(data, 0);
  // Encode two u64 (amount, maxSolCost):
  data.writeBigUInt64LE(BigInt(amount.toString()), BUY_DISCRIMINATOR.length + 0);
  data.writeBigUInt64LE(BigInt(maxSolCost.toString()), BUY_DISCRIMINATOR.length + 8);

  // Accounts
  const userATA = getAssociatedTokenAddressSync(mint, WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const globalVol = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID)[0];
  const userVol = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), WALLET.toBuffer()], PUMP_PROGRAM_ID)[0];

  // Fallback creator vault (the raw path needs it passed explicitly)
  const keys = [
    { pubkey: RAW_GLOBAL_PDA, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"), isSigner: false, isWritable: true }, // pool?
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: curve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: userATA, isSigner: false, isWritable: true },
    { pubkey: WALLET, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: CREATOR_VAULT_FALLBACK, isSigner: false, isWritable: true },
    { pubkey: RAW_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: globalVol, isSigner: false, isWritable: true },
    { pubkey: userVol, isSigner: false, isWritable: true },
  ];

  const ix = new anchor.web3.TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data });
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ix,
  ];
  return { ixs, signers: [] as Keypair[], amountBought: new BN(1) };
}

/** RAW discriminator SELL (from buy-from-pump.ts) */
async function ixSellPump_Raw(mint: PublicKey, curve: PublicKey, associatedBondingCurve: PublicKey) {
  // Fetch our ATA to sell full balance
  const userATA = getAssociatedTokenAddressSync(mint, WALLET, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const tokenAcc = await getAccount(connection, userATA);
  const amount = new BN(tokenAcc.amount.toString());

  const data = Buffer.alloc(SELL_DISCRIMINATOR.length + 16);
  SELL_DISCRIMINATOR.copy(data, 0);
  // Encode two u64 (amount, minSolOutput)
  data.writeBigUInt64LE(BigInt(amount.toString()), SELL_DISCRIMINATOR.length + 0);
  data.writeBigUInt64LE(BigInt(0), SELL_DISCRIMINATOR.length + 8);

  const keys = [
    { pubkey: RAW_GLOBAL_PDA, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"), isSigner: false, isWritable: true }, // pool?
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: curve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: userATA, isSigner: false, isWritable: true },
    { pubkey: WALLET, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: CREATOR_VAULT_FALLBACK, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: RAW_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const ix = new anchor.web3.TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data });
  return { ixs: [ix], signers: [] as Keypair[] };
}

/* ------------------------------ STATE / FLOW ----------------------------- */

const buys: Record<string, { buySlot: number; amount: BN }> = {};

async function sendTx(ixs: anchor.web3.TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = WALLET;
  const sig = await sendAndConfirmTransaction(connection, tx, [KEYPAIR, ...signers]);
  return sig;
}

async function doInitialBuy(mint: PublicKey, solAmount: number) {
  const lamports = Math.floor(solAmount * 1e9);
  // Ensure our ATA exists (regardless of path)
  const { ata, ixMaybe } = await ensureAta(WALLET, mint);
  const ixs: anchor.web3.TransactionInstruction[] = [];
  if (ixMaybe) ixs.push(ixMaybe); // optimistic ATA create

  let built, boughtAmount: BN;

  if (!USE_RAW_DISCRIMINATOR_BUILD) {
    // Anchor path
    const { ixs: buyIxs, signers, amountBought } = await ixBuyPump_Anchor(mint, lamports);
    ixs.push(...buyIxs);
    const sig = await sendTx(ixs, signers);
    console.log(`✅ Buy tx: https://solscan.io/tx/${sig}`);
    boughtAmount = amountBought;
  } else {
    // RAW path requires CURVE + associatedBondingCurve — derive them
    const [bondingCurve] = await PublicKey.findProgramAddress([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
    const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const { ixs: buyIxs, signers, amountBought } = await ixBuyPump_Raw(mint, bondingCurve, associatedBondingCurve, lamports);
    ixs.push(...buyIxs);
    const sig = await sendTx(ixs, signers);
    console.log(`✅ Buy tx: https://solscan.io/tx/${sig}`);
    boughtAmount = amountBought;
  }

  const buySlot = await connection.getSlot("confirmed");
  buys[mint.toBase58()] = { buySlot, amount: boughtAmount };
}

async function doAutoSellAfterBlocks(mint: PublicKey, blocks: number) {
  console.log(`⏳ Will auto-sell ${mint.toBase58()} after ${blocks} blocks...`);
  const sub = connection.onSlotChange(async (slotInfo) => {
    const mintStr = mint.toBase58();
    const entry = buys[mintStr];
    if (!entry) return;
    if (slotInfo.slot - entry.buySlot >= blocks) {
      // Build SELL
      if (!USE_RAW_DISCRIMINATOR_BUILD) {
        const { ixs, signers } = await ixSellPump_Anchor(mint, entry.amount);
        const sig = await sendTx(ixs, signers);
        console.log(`💸 Sold (anchor) tx: https://solscan.io/tx/${sig}`);
      } else {
        const [bondingCurve] = await PublicKey.findProgramAddress([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
        const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

        const { ixs, signers } = await ixSellPump_Raw(mint, bondingCurve, associatedBondingCurve);
        const sig = await sendTx(ixs, signers);
        console.log(`💸 Sold (raw) tx: https://solscan.io/tx/${sig}`);
      }
      delete buys[mintStr];
      connection.removeSlotChangeListener(sub);
    }
  });
}

/* --------------------------------- MAIN ---------------------------------- */

(async () => {
  console.log("🔧 RPC:", argv.rpc);
  console.log("👤 Wallet:", WALLET.toBase58());

  if (!argv.mint) {
    throw new Error("Please provide --mint <base_mint_address>");
  }
  const mint = new PublicKey(argv.mint);

  if (argv.buy && argv.sol > 0) {
    await doInitialBuy(mint, argv.sol);
  }

  if (argv.auto) {
    await doAutoSellAfterBlocks(mint, argv.blocks);
  } else {
    // Not auto-running; exit after optional buy
    process.exit(0);
  }
})().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});

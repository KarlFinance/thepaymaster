/**
 * Certificates on chain.
 *
 * When a record is sealed, each party to it can be given a soulbound token
 * on Base: minted by the platform's attestation key to the address that party
 * proved control of, with an id derived from the record root and the party.
 * The token proves, on a public chain and for as long as the chain lasts,
 * that a certificate exists for that root — and the record root is what the
 * verifier checks. Nothing personal goes on chain: no name, no amount.
 *
 * Minting costs gas, so it is a deliberate act by staff after sealing, from
 * the dossier page, and the platform's key has to hold a little ETH on Base.
 * The contract is deployed once per chain from the same key.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { type Env, type Actor, id, insert, log } from "./db.ts";
import { sendTx, call, nativeBalance, addressOf, hex, unhex, abiAddress, abiUint, abiString, selector } from "./evm.ts";
import { CHAINS } from "./chain.ts";
import { seals } from "./dossier.ts";
import { VERIFY_URL } from "./verify.ts";
import artefact from "./certificates.json" with { type: "json" };

/** Where certificates live. Base for real records; Base Sepolia for rehearsals. */
export const BADGE_CHAINS = { live: 8453, rehearsal: 84532 } as const;
export const BADGE_BASE_URI = "https://client.thepaymaster.co.uk/badge/";

const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

function keyOf(env: Env): Uint8Array | null {
  const k = (env as any).ATTEST_KEY as string | undefined;
  if (!k || !/^(0x)?[0-9a-fA-F]{64}$/.test(k.trim())) return null;
  return unhex(k.trim());
}

/** The token id for a party's certificate on a sealed root; or the transaction's own. */
export function tokenIdFor(root: string, partyId: string | null): string {
  return hex(keccak_256(concat(unhex(root), new TextEncoder().encode(partyId ?? "transaction"))));
}

export interface Contract { chain_id: number; address: string; deploy_tx: string; deployed_at: string }

export async function contractFor(env: Env, chainId: number): Promise<Contract | null> {
  return env.DB.prepare("SELECT * FROM badge_contracts WHERE chain_id = ?").bind(chainId).first<Contract>();
}

/** The signing address and what it holds on each chain — the page staff read before minting. */
export async function attesterStatus(env: Env): Promise<{ address: string | null; chains: { chainId: number; name: string; balance: bigint | null; contract: Contract | null }[] }> {
  const k = keyOf(env);
  const address = k ? addressOf(k) : null;
  const chains = [];
  for (const chainId of [BADGE_CHAINS.live, BADGE_CHAINS.rehearsal]) {
    let balance: bigint | null = null;
    if (address) { try { balance = await nativeBalance(env, chainId, address); } catch { /* unknown */ } }
    chains.push({ chainId, name: CHAINS[chainId]?.name ?? String(chainId), balance, contract: await contractFor(env, chainId) });
  }
  return { address, chains };
}

/** Deploy the certificate contract on a chain, once. */
export async function deployContract(env: Env, actor: Actor, chainId: number): Promise<string | null> {
  const k = keyOf(env);
  if (!k) return "No attestation key is configured.";
  if (await contractFor(env, chainId)) return "Already deployed on that chain.";
  if (!CHAINS[chainId]) return "Not a chain we know.";
  const data = concat(unhex((artefact as any).bytecode), abiString(BADGE_BASE_URI));
  let res;
  try {
    res = await sendTx(env, k, { chainId, to: null, value: 0n, data, gasLimit: 1_200_000n });
  } catch (err) { return `Could not send: ${(err as Error).message}`; }
  if (!res.status || !res.contractAddress) return `The deployment transaction ${res.hash} did not succeed (or has not yet been mined). Check it on the explorer before trying again.`;
  await env.DB.prepare("INSERT INTO badge_contracts (chain_id, address, deploy_tx, deployed_by) VALUES (?, ?, ?, ?)")
    .bind(chainId, res.contractAddress, res.hash, actor.id ?? "unknown").run();
  await log(env.DB, actor, "badges.contract_deployed", "badge_contracts", String(chainId),
    { note: `${res.contractAddress} by ${res.hash}` });
  return null;
}

export interface Badge {
  id: string; transaction_id: string; party_id: string | null; seal_id: string; chain_id: number;
  contract: string; token_id: string; to_address: string; tx_hash: string; minted_at: string;
}

export async function badgesFor(env: Env, txId: string): Promise<Badge[]> {
  const { results } = await env.DB.prepare("SELECT * FROM badges WHERE transaction_id = ? ORDER BY minted_at").bind(txId).all<Badge>();
  return results ?? [];
}

/**
 * Mint a certificate for every party with a proved address, and one for the
 * transaction to our fee wallet. Idempotent: a party already holding theirs is
 * skipped, so a run that stopped halfway can be run again.
 */
export async function mintCertificates(env: Env, actor: Actor, txId: string, chainId: number):
    Promise<{ minted: string[]; skipped: string[]; problem?: string }> {
  const k = keyOf(env);
  if (!k) return { minted: [], skipped: [], problem: "No attestation key is configured." };
  const contract = await contractFor(env, chainId);
  if (!contract) return { minted: [], skipped: [], problem: `The certificate contract is not deployed on ${CHAINS[chainId]?.name ?? chainId} yet.` };
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!tx) return { minted: [], skipped: [], problem: "No such transaction." };
  const history = await seals(env, txId);
  const seal: any = history[0];
  if (!seal) return { minted: [], skipped: [], problem: "Seal the record first: a certificate commits to a sealed root." };

  const { results: people } = await env.DB.prepare(
    `SELECT p.party_id, p.role, y.display_name,
            (SELECT d.address FROM destinations d WHERE d.participation_id = p.id AND d.status = 'locked' LIMIT 1) AS dest,
            (SELECT w.address FROM sending_wallets w WHERE w.transaction_id = p.transaction_id AND w.party_id = p.party_id
               AND w.removed_at IS NULL AND w.proved_at IS NOT NULL ORDER BY w.created_at LIMIT 1) AS wallet
       FROM participations p JOIN parties y ON y.id = p.party_id WHERE p.transaction_id = ?`).bind(txId).all<any>();

  const targets: { partyId: string | null; who: string; to: string | null }[] = [
    { partyId: null, who: "the transaction (to our fee wallet)", to: tx.fee_wallet ?? null },
    ...(people ?? []).map((p: any) => ({ partyId: p.party_id, who: p.display_name, to: p.role === "sender" ? p.wallet : p.dest })),
  ];
  const already = new Set((await badgesFor(env, txId)).filter((b) => b.chain_id === chainId).map((b) => b.token_id));
  const minted: string[] = [], skipped: string[] = [];

  for (const t of targets) {
    const tokenId = tokenIdFor(seal.root, t.partyId);
    if (already.has(tokenId)) { skipped.push(`${t.who}: already holds it`); continue; }
    if (!t.to || !/^0x[0-9a-fA-F]{40}$/.test(t.to)) { skipped.push(`${t.who}: no proved Ethereum-style address to send it to`); continue; }
    // Is it already minted on chain by an earlier run that failed to record?
    try {
      const owner = await call(env, chainId, contract.address, concat(selector("ownerOf(uint256)"), abiUint(BigInt(tokenId))));
      if (owner && owner !== "0x" && BigInt(owner) !== 0n) { skipped.push(`${t.who}: already on chain`); continue; }
    } catch { /* reverts when absent — expected */ }
    let res;
    try {
      res = await sendTx(env, k, { chainId, to: contract.address, value: 0n, gasLimit: 120_000n,
        data: concat(selector("mint(address,uint256)"), abiAddress(t.to), abiUint(BigInt(tokenId))) });
    } catch (err) { return { minted, skipped, problem: `${t.who}: could not send — ${(err as Error).message}` }; }
    if (!res.status) return { minted, skipped, problem: `${t.who}: transaction ${res.hash} did not succeed (or is not yet mined). Nothing after it was attempted.` };
    await insert(env.DB, actor, "badge.minted", "badges", id("bdg"), {
      transaction_id: txId, party_id: t.partyId, seal_id: seal.id, chain_id: chainId, contract: contract.address,
      token_id: tokenId, to_address: t.to, tx_hash: res.hash, minted_by: actor.id ?? "unknown",
    }, { note: `${t.who} → ${t.to} on ${CHAINS[chainId]?.name}` });
    minted.push(`${t.who} — ${res.hash}`);
  }
  return { minted, skipped };
}

// --- the public face of a token ---------------------------------------------------------------

async function badgeByToken(env: Env, tokenId: string) {
  return env.DB.prepare(
    `SELECT b.*, t.ref, s.root, s.sealed_at, s.anchor_tx_hash,
            (SELECT role FROM participations p WHERE p.transaction_id = b.transaction_id AND p.party_id = b.party_id LIMIT 1) AS role
       FROM badges b JOIN transactions t ON t.id = b.transaction_id JOIN dossier_seals s ON s.id = b.seal_id
      WHERE lower(b.token_id) = lower(?) LIMIT 1`).bind(tokenId.startsWith("0x") ? tokenId : "0x" + tokenId).first<any>();
}

/** ERC-721 metadata: what a wallet or explorer shows. No names, no amounts. */
export async function badgeMetadata(env: Env, tokenId: string): Promise<string | null> {
  const b = await badgeByToken(env, tokenId);
  if (!b) return null;
  const whatFor = b.party_id ? `the ${b.role ?? "party"}'s certificate` : "the transaction's own certificate";
  return JSON.stringify({
    name: `ThePaymaster Certificate — ${b.ref}`,
    description: `A soulbound certificate from ThePaymaster® for ${whatFor} on transaction ${b.ref}. ` +
      `Its id is derived from the sealed record root ${b.root} (sealed ${String(b.sealed_at).slice(0, 16)} UTC). ` +
      `The record can be verified at ${VERIFY_URL}. ThePaymaster acted exclusively as the sender's agent (PSR 2017 Sch 1 para 2(b)).`,
    image: `${BADGE_BASE_URI}${b.token_id.replace(/^0x/, "")}.svg`,
    external_url: VERIFY_URL,
    attributes: [
      { trait_type: "Reference", value: b.ref },
      { trait_type: "Record root", value: b.root },
      { trait_type: "Sealed", value: String(b.sealed_at).slice(0, 16) + " UTC" },
      { trait_type: "Holder", value: b.party_id ? (b.role ?? "party") : "transaction" },
      ...(b.anchor_tx_hash ? [{ trait_type: "Anchored on Ethereum", value: b.anchor_tx_hash }] : []),
    ],
  }, null, 2);
}

/** The image: brand colours, the reference, the root — generated, self-contained. */
export async function badgeSvg(env: Env, tokenId: string): Promise<string | null> {
  const b = await badgeByToken(env, tokenId);
  if (!b) return null;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const role = b.party_id ? (b.role === "sender" ? "Sender" : "Recipient") : "Transaction";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0F1A2B"/><stop offset="1" stop-color="#1B2430"/></linearGradient></defs>
  <rect width="600" height="600" rx="28" fill="url(#g)"/>
  <rect x="24" y="24" width="552" height="552" rx="20" fill="none" stroke="#F26A21" stroke-width="3"/>
  <text x="48" y="92" font-family="Helvetica, Arial, sans-serif" font-size="14" letter-spacing="4" fill="#9FB0C6">THEPAYMASTER® CERTIFICATE</text>
  <text x="48" y="150" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#FFFFFF">${esc(b.ref)}</text>
  <text x="48" y="188" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#F26A21">${role}</text>
  <text x="48" y="250" font-family="Helvetica, Arial, sans-serif" font-size="13" letter-spacing="3" fill="#9FB0C6">SEALED RECORD ROOT</text>
  <text x="48" y="280" font-family="Menlo, Consolas, monospace" font-size="15" fill="#E6EAF0">${esc(b.root.slice(0, 32))}</text>
  <text x="48" y="302" font-family="Menlo, Consolas, monospace" font-size="15" fill="#E6EAF0">${esc(b.root.slice(32))}</text>
  <text x="48" y="350" font-family="Helvetica, Arial, sans-serif" font-size="13" letter-spacing="3" fill="#9FB0C6">SEALED</text>
  <text x="48" y="376" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#FFFFFF">${esc(String(b.sealed_at).slice(0, 16))} UTC</text>
  <text x="48" y="470" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#9FB0C6">Soulbound. Verify the record at</text>
  <text x="48" y="492" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#FFFFFF">client.thepaymaster.co.uk/verify-record</text>
  <text x="48" y="540" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#5A6B80">ThePaymaster Ltd · acting exclusively as the sender's agent · PSR 2017 Sch 1 para 2(b)</text>
</svg>`;
}

export function explorerToken(chainId: number, contract: string, tokenId: string): string {
  const base = CHAINS[chainId]?.explorer ?? "https://basescan.org";
  return `${base}/nft/${contract}/${BigInt(tokenId).toString()}`;
}

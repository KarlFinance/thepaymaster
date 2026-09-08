/**
 * Compile the rehearsal contracts and write their bytecode and ABI.
 *
 * Optimiser on, because the disburser's loop is what a real distribution will
 * spend its gas in, and rehearsing against unoptimised bytecode would give a
 * gas figure that means nothing.
 */
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

const sources = {};
for (const f of readdirSync("contracts")) {
  if (f.endsWith(".sol")) sources[f] = { content: readFileSync(`contracts/${f}`, "utf8") };
}

const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.gasEstimates"] } },
  },
})));

let failed = false;
for (const e of out.errors ?? []) {
  if (e.severity === "error") { failed = true; console.error(e.formattedMessage); }
  else console.warn("  " + e.formattedMessage.split("\n")[0]);
}
if (failed) process.exit(1);

mkdirSync("build", { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    const bytecode = c.evm.bytecode.object;
    writeFileSync(`build/${name}.json`,
      JSON.stringify({ abi: c.abi, bytecode: "0x" + bytecode }, null, 2));
    console.log(`  ${name.padEnd(12)} ${(bytecode.length / 2).toLocaleString()} bytes` +
      `  (limit 24,576)`);
  }
}

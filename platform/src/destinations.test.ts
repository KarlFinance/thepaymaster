import { problemWith, ibanChecksum, describe } from "./destinations.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${n}`);
};

// Real published test IBANs.
check("valid GB IBAN",  ibanChecksum("GB82WEST12345698765432"), true);
check("valid DE IBAN",  ibanChecksum("DE89370400440532013000"), true);
check("valid IE IBAN",  ibanChecksum("IE29AIBK93115212345678"), true);
// A transposed pair — the mistake the checksum exists to catch.
check("transposed digits caught", ibanChecksum("GB82WEST12345698765423"), false);
check("one digit wrong caught",   ibanChecksum("DE89370400440532013001"), false);

const bank = { account_name: "H Marsh", bank_name: "Barclays", bank_country: "United Kingdom" };
check("IBAN accepted", problemWith("bank", { ...bank, iban: "GB82 WEST 1234 5698 7654 32" }), null);
check("bad IBAN refused",
  (problemWith("bank", { ...bank, iban: "GB82WEST12345698765423" }) ?? "").includes("check digits"), true);
check("account plus sort code accepted",
  problemWith("bank", { ...bank, account_number: "12345678", sort_code: "20-00-00" }), null);
check("sort code alone is not enough",
  (problemWith("bank", { ...bank, account_number: "12345678", sort_code: "2000" }) ?? "").includes("six digits"), true);
check("no numbers at all refused",
  (problemWith("bank", bank) ?? "").includes("either an IBAN"), true);
check("missing account name refused",
  (problemWith("bank", { bank_name: "X", bank_country: "UK", iban: "GB82WEST12345698765432" }) ?? "")
    .includes("name on the account"), true);

check("ethereum address accepted",
  problemWith("wallet", { chain: "ethereum", address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" }), null);
check("short hex refused",
  (problemWith("wallet", { chain: "ethereum", address: "0x742d35Cc" }) ?? "").includes("forty hex"), true);
check("missing chain refused",
  (problemWith("wallet", { address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" }) ?? "")
    .includes("which chain"), true);
check("a bank field cannot smuggle in as a wallet",
  (problemWith("wallet", { chain: "ethereum", address: "" }) ?? "").includes("wallet address"), true);

// What the recipient reads back must contain the numbers in full, never
// abbreviated — an abbreviation is how a wrong digit survives a check.
const shown = describe({ id: "d", participation_id: "p", kind: "bank", status: "draft",
  account_name: "H Marsh", bank_name: "Barclays", bank_country: "United Kingdom",
  iban: "GB82WEST12345698765432" } as any);
check("read-back shows the whole IBAN", shown.includes("GB82WEST12345698765432"), true);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");

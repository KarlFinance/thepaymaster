import { verify, base32Encode, base32Decode, randomSecret, enrolmentUri } from "./totp.ts";

let bad = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { bad++; console.log(`  FAIL ${name}\n       got ${g} want ${w}`); }
  else console.log(`  ok   ${name}`);
};

// RFC 4648 base32 vectors, so the encoding is not merely self-consistent.
const enc = new TextEncoder();
check("base32 'f'",      base32Encode(enc.encode("f")),      "MY");
check("base32 'fo'",     base32Encode(enc.encode("fo")),     "MZXQ");
check("base32 'foobar'", base32Encode(enc.encode("foobar")), "MZXW6YTBOI");
check("round trip", new TextDecoder().decode(base32Decode("MZXW6YTBOI")), "foobar");

// RFC 6238 test vector: the ASCII secret "12345678901234567890" at T=59
// produces 287082 with SHA-1 and six digits.
const rfcSecret = base32Encode(enc.encode("12345678901234567890"));
const realNow = Date.now;
Date.now = () => 59_000;
check("RFC 6238 vector at T=59", await verify(rfcSecret, "287082"), true);
check("a wrong code is refused", await verify(rfcSecret, "000000"), false);
Date.now = () => 1_111_111_109_000;
check("RFC 6238 vector at T=1111111109", await verify(rfcSecret, "081804"), true);
Date.now = realNow;

const s = randomSecret();
check("secret is 32 base32 chars", s.length, 32);
check("a random code is refused", await verify(s, "123456"), false);
check("short input is refused", await verify(s, "1234"), false);
check("uri names the issuer", enrolmentUri("a@b.com", s).includes("issuer=ThePaymaster"), true);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");

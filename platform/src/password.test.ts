import { hashPassword, checkPassword, passwordProblem } from "./adminauth.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++; console.log(`  FAIL ${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${n}`);
};

const hash = await hashPassword("quarry-lantern-beacon-19");
check("scheme is the chained one", hash.split("$")[0], "pbkdf2c");
check("work factor recorded", hash.split("$")[1], "3x100000");
// Workers refuses anything above this, and that is the whole reason for the
// chain — so assert it rather than trusting the constant not to drift.
check("no single call exceeds the Workers cap",
  Number(hash.split("$")[1].split("x")[1]) <= 100_000, true);
check("right password verifies", await checkPassword("quarry-lantern-beacon-19", hash), true);
check("wrong password does not", await checkPassword("quarry-lantern-beacon-18", hash), false);
check("no stored hash is refused", await checkPassword("anything", null), false);
check("a mangled hash is refused", await checkPassword("x", "notahash"), false);
check("an over-cap stored hash is refused",
  await checkPassword("x", "pbkdf2c$1x210000$AAAA$BBBB"), false);
check("two hashes of one password differ (salted)",
  (await hashPassword("same")) === (await hashPassword("same")), false);
check("short password rejected", passwordProblem("short") !== null, true);
check("long password accepted", passwordProblem("quarry-lantern-beacon-19"), null);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");

/**
 * Create an admin account.
 *
 * Prints the SQL and a temporary password. Apply the SQL yourself, hand the
 * password over in person or through a password manager, and it must be
 * changed at first sign-in — the account cannot reach anything until it is.
 *
 *   node --experimental-strip-types tools/provision.ts "Ray Lovell" rl@thepaymaster.co.uk
 */
import { hashPassword } from "../src/adminauth.ts";

const [name, email] = process.argv.slice(2);
if (!name || !email) {
  console.error('usage: provision.ts "Full Name" email@thepaymaster.co.uk');
  process.exit(1);
}

// Four words and a number: long enough to be strong, speakable enough to be
// read down a phone without spelling every character.
const WORDS = ["harbour", "lantern", "meadow", "compass", "thistle", "quarry",
  "beacon", "orchard", "cinder", "willow", "granite", "marlin", "pewter",
  "saffron", "tundra", "vellum", "juniper", "kestrel"];
const pick = () => WORDS[crypto.getRandomValues(new Uint32Array(1))[0] % WORDS.length];
const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100).padStart(2, "0");
const password = [pick(), pick(), pick(), pick()].join("-") + "-" + digits;

const hash = await hashPassword(password);
const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
const id = "adm_" + [...crypto.getRandomValues(new Uint8Array(8))]
  .map((b) => alphabet[b % alphabet.length]).join("");

console.log(`INSERT INTO admins (id, email, name, role, password_hash, must_change_password)`);
console.log(`VALUES ('${id}', '${email.replace(/'/g, "''")}', '${name.replace(/'/g, "''")}', 'owner', '${hash}', 1);`);
console.log(`-- ${email} temporary password: ${password}`);

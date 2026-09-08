/**
 * Print the SQL to create an admin, with the password already hashed.
 *
 * Run it, read the SQL, apply it yourself. The password never travels through
 * a command that ends up in shell history or a log with the account it belongs
 * to, and nothing here writes to a database on its own.
 *
 *   node --experimental-strip-types tools/seed.ts "Rich" rl@karl.finance
 */
import { hashPassword } from "../src/auth.ts";

const [name, email] = process.argv.slice(2);
if (!name || !email) {
  console.error('usage: seed.ts "Name" email@example.com');
  process.exit(1);
}

// A password you never have to remember, because you will replace this with
// Cloudflare Access before it matters.
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const bytes = crypto.getRandomValues(new Uint8Array(20));
const password = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");

const hash = await hashPassword(password);
const id = "adm_" + [...crypto.getRandomValues(new Uint8Array(8))]
  .map((b) => "23456789abcdefghjkmnpqrstuvwxyz"[b % 31]).join("");

console.log(`\n-- ${email}\nINSERT INTO admins (id, email, name, role, password_hash)`);
console.log(`VALUES ('${id}', '${email.replace(/'/g, "''")}', '${name.replace(/'/g, "''")}', 'owner', '${hash}');`);
console.log(`\npassword: ${password}\n`);

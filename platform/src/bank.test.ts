import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatement, legReference, feeReference, pennyCode, pennyReference } from "./bank.ts";

test("references", () => {
  assert.equal(legReference("TPM-2026-0002", 1), "TPM-2026-0002-01");
  assert.equal(legReference("TPM-2026-0002", 12), "TPM-2026-0002-12");
  assert.equal(feeReference("TPM-2026-0002"), "TPM-2026-0002-FEE");
  const c = pennyCode();
  assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(pennyReference("K7X2QM"), "TPM PENNY K7X2QM");
});

test("HSBC-style export: paid in / paid out columns, d/m/y dates", () => {
  const csv = [
    "Date,Type,Description,Paid out,Paid in,Balance",
    "10/09/2026,CR,TPM-2026-0002 J SMITH,,\"1,010.11\",\"5,010.11\"",
    "11/09/2026,BP,TPM-2026-0002-01 A JONES,500.00,,\"4,510.11\"",
    "11/09/2026,BP,TPM PENNY K7X2QM,0.01,,\"4,510.10\"",
    "11/09/2026,,Interest,,,",
  ].join("\n");
  const { lines, skipped } = parseStatement(csv, 2);
  assert.equal(skipped, 1);
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].booked_on, lines[0].direction, lines[0].amount_minor], ["2026-09-10", "in", 101011]);
  assert.deepEqual([lines[1].direction, lines[1].amount_minor], ["out", 50000]);
  assert.equal(lines[2].amount_minor, 1);
  assert.match(lines[2].reference, /TPM PENNY K7X2QM/);
});

test("single signed amount column, ISO dates, semicolons", () => {
  const csv = "Booking date;Reference;Amount\n2026-09-10;TPM-2026-0003;2500.00\n2026-09-11;TPM-2026-0003-FEE;-25.00\n";
  const { lines } = parseStatement(csv, 2);
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].direction, lines[0].amount_minor], ["in", 250000]);
  assert.deepEqual([lines[1].direction, lines[1].amount_minor], ["out", 2500]);
});

test("a file that is not a statement yields nothing rather than nonsense", () => {
  const { lines } = parseStatement("name,email\nA,a@b.c\n", 2);
  assert.equal(lines.length, 0);
});

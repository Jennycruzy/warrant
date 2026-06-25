// Advance the prover's persisted private book after a SUCCESSFUL settlement.
// Mirrors the circuit's state transition: position += amount (equity unchanged).
//
// Usage: node advance_book.js <bookFile> <amount>
const fs = require("fs");

const [bookFile, amount] = process.argv.slice(2);
if (!bookFile || amount === undefined) {
  console.error("usage: node advance_book.js <bookFile> <amount>");
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(bookFile, "utf8"));
state.book.position = (BigInt(state.book.position) + BigInt(amount)).toString();
fs.writeFileSync(bookFile, JSON.stringify(state, null, 2));
console.log("book advanced: position = " + state.book.position);

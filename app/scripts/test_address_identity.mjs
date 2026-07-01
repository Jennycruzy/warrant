import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addressIdentity } from "./address_identity.mjs";

const fixtures = JSON.parse(
  await readFile(new URL("./address_identity_fixtures.json", import.meta.url), "utf8"),
);

for (const [label, fixture] of Object.entries(fixtures)) {
  const actual = addressIdentity(fixture.strkey);
  assert.deepEqual(actual, {
    recipientType: fixture.recipientType,
    bytesHex: fixture.bytesHex,
    recipientHi: fixture.recipientHi,
    recipientLo: fixture.recipientLo,
  });
  console.log(
    `Phase A JS ${label}: type=${actual.recipientType} bytes=${actual.bytesHex} hi=${actual.recipientHi} lo=${actual.recipientLo}`,
  );
}

import fs from "node:fs";
import path from "node:path";
import { buildAddressControls } from "./addr_controls.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const configPath = process.argv[2] || path.join(ROOT, "app/frontend/public/demo-config.json");
const outPath = process.argv[3] || path.join(ROOT, "app/frontend/public/controls/manifest.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const manifest = await buildAddressControls(config);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `wrote ${manifest.states.length} address-bound control states for ${manifest.recipients.length} recipients to ${path.relative(ROOT, outPath)}`
);

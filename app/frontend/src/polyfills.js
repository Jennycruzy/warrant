// Must be imported before any module that touches Node globals (snarkjs,
// @stellar/stellar-sdk). ESM evaluates imports in order, so importing this first
// in main.jsx guarantees Buffer/global/process exist before those libraries load.
import { Buffer } from "buffer";

if (typeof globalThis.global === "undefined") globalThis.global = globalThis;
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
if (typeof globalThis.process === "undefined") globalThis.process = { env: {} };

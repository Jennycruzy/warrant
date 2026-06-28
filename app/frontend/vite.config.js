import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// snarkjs and @stellar/stellar-sdk reference Node globals (Buffer/global/process);
// the polyfills make them work in the browser, otherwise the app throws at load.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  server: { host: "0.0.0.0" },
});

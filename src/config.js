// Shared config — loaded by both popup.html (<script>) and background.js (importScripts).
// The popup tries these key-API bases IN ORDER and automatically falls back to the next
// one on a network/TLS failure (e.g. while a new cert is still provisioning). Add as many
// as you like — just keep each origin in manifest.json "host_permissions".
self.NEXA_API_BASES = [
  "https://deliveroo.nexaserve.uk",            // primary — custom domain
  "https://roo-ext-production.up.railway.app", // fallback — Railway default domain
];
self.NEXA_API_BASE = self.NEXA_API_BASES[0]; // back-compat single value

// Shared app key sent (base64) as the `x-app-key` header on every key-API call. MUST match
// the server's APP_KEY (env on Railway, or its built-in default). To rotate: change it here,
// in both background.js files, in the Orion content.js, and the server APP_KEY — then rebuild.
self.NEXA_APP_KEY = "NEXA-DROO-APP-7kyM77W-_01UYy42NUpJZ5cS";

// Server response-signing PUBLIC key (L3), base64 SPKI. Safe to ship — it's a public key. When
// set, the popup refuses to trust a validate/redeem "valid:true" unless the server's
// x-roo-resp-sig signature verifies (blocks a spoofed/MITM licence server). Leave "" to disable
// the check (fail-open) until you've copied the deployed server's key. Get it from:
//   GET https://deliveroo.nexaserve.uk/api/pubkey  →  the "spki_b64" field.
self.NEXA_RESP_PUBKEY_SPKI_B64 = "";

// crypto.js — shared device-identity + request-signing module (L1) and server-response
// verification (L3). Loaded by BOTH the popup (<script> in popup.html, before popup.js) and the
// background service worker (importScripts, before the rest of background.js). Exposes a single
// global, self.NexaCrypto.
//
// The device keypair is ECDSA P-256, generated with extractable:false, and persisted as a
// CryptoKey in IndexedDB. The private key's bytes can NEVER be read out of JS — not even by a
// reverse-engineer with the unpacked extension — so a captured build can't be replayed from
// somewhere else. We sign every key-API request; the server verifies against the public key we
// registered on redeem. We also verify the server's response signature so a spoofed/MITM server
// can't fake a licence.
(function () {
  "use strict";
  if (self.NexaCrypto) return; // already loaded in this context

  var subtle = (self.crypto && self.crypto.subtle) || null;

  /* ---- tiny IndexedDB store (works in both the SW and the popup window) ---- */
  function idb() {
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open("nexa-device", 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore("keys"); };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction("keys", "readonly").objectStore("keys").get(k);
        t.onsuccess = function () { res(t.result); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  function idbSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put(v, k);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  /* ---- helpers ---- */
  function bufToB64(buf) {
    var u = new Uint8Array(buf), s = "";
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function b64ToBuf(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function randHex(n) {
    var u = new Uint8Array(n); self.crypto.getRandomValues(u);
    var s = ""; for (var i = 0; i < u.length; i++) s += ("0" + u[i].toString(16)).slice(-2);
    return s;
  }
  function sha256Hex(str) {
    return subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (buf) {
      var u = new Uint8Array(buf), h = "";
      for (var i = 0; i < u.length; i++) h += ("0" + u[i].toString(16)).slice(-2);
      return h;
    });
  }

  /* ---- device keypair (non-exportable private key) ---- */
  var _kp = null;
  function getDeviceKeys() {
    if (_kp) return Promise.resolve(_kp);
    return idbGet("deviceKeyPair").catch(function () { return null; }).then(function (kp) {
      if (kp && kp.privateKey) { _kp = kp; return kp; }
      return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]).then(function (gen) {
        return idbSet("deviceKeyPair", gen).catch(function () {}).then(function () { _kp = gen; return gen; });
      });
    });
  }
  // base64 SPKI of the public key — registered with the server on redeem.
  function getDevicePubB64() {
    return getDeviceKeys().then(function (kp) {
      return subtle.exportKey("spki", kp.publicKey).then(bufToB64);
    });
  }

  /* ---- request signing (L1) ---- */
  // Returns { ts, nonce, sig } for the canonical string METHOD\npath\nts\nnonce\nsha256(body).
  // sig is base64 of the raw r||s (IEEE P1363) ECDSA signature — matches the server's
  // dsaEncoding:"ieee-p1363" verify.
  function signRequest(method, path, bodyStr) {
    return getDeviceKeys().then(function (kp) {
      var ts = String(Date.now()), nonce = randHex(16);
      return sha256Hex(bodyStr || "").then(function (bodyHash) {
        var canonical = [method, path, ts, nonce, bodyHash].join("\n");
        return subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(canonical))
          .then(function (sigBuf) { return { ts: ts, nonce: nonce, sig: bufToB64(sigBuf) }; });
      });
    });
  }

  /* ---- server response verification (L3) ---- */
  var _serverPub = null;
  function serverPubKey() {
    if (_serverPub) return Promise.resolve(_serverPub);
    var b = self.NEXA_RESP_PUBKEY_SPKI_B64;
    if (!b) return Promise.resolve(null); // not configured → verification is a no-op (see verifyResponse)
    return subtle.importKey("spki", b64ToBuf(b), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      .then(function (k) { _serverPub = k; return k; })
      .catch(function () { return null; });
  }
  // true  = signature is valid OR verification isn't configured (fail-open until the key ships)
  // false = a server pubkey IS configured and the signature did NOT verify (reject this response)
  function verifyResponse(bodyStr, sigB64) {
    return serverPubKey().then(function (pub) {
      if (!pub) return true;            // not configured → don't block
      if (!sigB64) return false;        // configured but server sent no signature → reject
      return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64ToBuf(sigB64), new TextEncoder().encode(bodyStr))
        .catch(function () { return false; });
    });
  }
  // Whether response verification is switched on (a pubkey is embedded).
  function responseVerifyEnabled() { return !!self.NEXA_RESP_PUBKEY_SPKI_B64; }

  self.NexaCrypto = {
    getDeviceKeys: getDeviceKeys,
    getDevicePubB64: getDevicePubB64,
    signRequest: signRequest,
    verifyResponse: verifyResponse,
    responseVerifyEnabled: responseVerifyEnabled,
    available: !!subtle,
  };
})();

// popup.js — license lock + (once unlocked) "Clear data" and the SMSPool key field.

const API_BASES = (Array.isArray(self.NEXA_API_BASES) && self.NEXA_API_BASES.length
  ? self.NEXA_API_BASES
  : [self.NEXA_API_BASE || "http://localhost:8787"]
).map((b) => String(b).replace(/\/+$/, ""));

// App key, sent base64-encoded as `x-app-key` on every key-API call (must match server APP_KEY).
// The header encodes "<appKey>|<ip>"; the IP lets the server (when BIND_IP is on) bind the
// request to the device's current IP. __rooIp is learned from the server and refreshed when it
// changes (the ip_mismatch retry below).
const NEXA_APP_KEY = self.NEXA_APP_KEY || "";
let __rooIp = "";
function appKeyHeader() {
  return (typeof btoa === "function" && NEXA_APP_KEY) ? btoa(NEXA_APP_KEY + "|" + (__rooIp || "")) : "";
}

// Per-device signature headers (L1). Harmless when the server isn't enforcing (REQUIRE_SIG off);
// required once it is. Empty object if NexaCrypto/WebCrypto is unavailable.
async function signHeaders(method, path, bodyStr) {
  try {
    if (!self.NexaCrypto || !self.NexaCrypto.available) return {};
    const d = await chrome.storage.local.get("deviceId");
    const s = await self.NexaCrypto.signRequest(method || "GET", path, bodyStr || "");
    return { "x-roo-ts": s.ts, "x-roo-nonce": s.nonce, "x-roo-sig": s.sig, "x-roo-device": (d && d.deviceId) || "" };
  } catch (e) { return {}; }
}

// Server-issued session token (HMAC, IP-bound, sliding 30-min TTL). Stored in chrome.storage so
// the popup + background share it, sent as x-roo-session, and refreshed from each response.
async function getSession() { try { return (await chrome.storage.local.get("rooSession")).rooSession || ""; } catch (e) { return ""; } }
async function setSession(t) { try { if (t) await chrome.storage.local.set({ rooSession: t }); } catch (e) {} }
// Re-obtain a token by re-validating (validate is session-exempt and issues a fresh one).
async function renewSession() {
  try {
    const d = await chrome.storage.local.get(["license", "deviceId"]);
    if (!d.license || !d.license.key) return;
    await apiFetch("/api/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: d.license.key, device_id: d.deviceId }) });
  } catch (e) {}
}

// Try each base in order; fall back to the next on a network/TLS failure (a thrown fetch or an
// >8s hang). An actual HTTP response — even 4xx — counts as "reached", so a 404 (invalid key)
// does NOT trigger fallback. Self-heals two server rejections by retrying once each: ip_mismatch
// (adopt the returned IP) and session_required (re-validate for a fresh token). Every response's
// refreshed x-roo-session is captured. Throws only if every base is unreachable.
async function apiFetch(path, opts) {
  opts = opts || {};
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const h = appKeyHeader();
    const tok = await getSession();
    const sig = await signHeaders(opts.method || "GET", path, typeof opts.body === "string" ? opts.body : "");
    const headers = Object.assign({}, opts.headers, sig, h ? { "x-app-key": h } : {}, tok ? { "x-roo-session": tok } : {});
    let retry = false;
    for (const base of API_BASES) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(base + path, Object.assign({}, opts, { headers, signal: ctrl.signal }));
        clearTimeout(timer);
        const fresh = res.headers.get("x-roo-session"); if (fresh) await setSession(fresh);
        if (attempt < 2) {
          if (res.status === 403) {
            const d = await res.clone().json().catch(() => ({}));
            if (d && d.error === "ip_mismatch" && d.ip) { __rooIp = d.ip; retry = true; break; }
          } else if (res.status === 401) {
            const d = await res.clone().json().catch(() => ({}));
            if (d && d.error === "session_required") { await renewSession(); retry = true; break; }
          }
        }
        // L3: when a server response pubkey is configured, reject a response whose signature
        // doesn't verify (spoofed/MITM server). Try the next base before giving up.
        if (self.NexaCrypto && self.NexaCrypto.responseVerifyEnabled()) {
          const ok = await self.NexaCrypto.verifyResponse(await res.clone().text(), res.headers.get("x-roo-resp-sig"));
          if (!ok) { lastErr = new Error("response signature invalid"); continue; }
        }
        return res;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
      }
    }
    if (!retry) break;
  }
  throw lastErr || new Error("no API base reachable");
}

/* ───────────────────────────── license lock ───────────────────────────── */

const lockScreen = document.getElementById("lockScreen");
const mainScreen = document.getElementById("mainScreen");
const licenseKeyEl = document.getElementById("licenseKey");
const unlockBtn = document.getElementById("unlock");
const lockStatus = document.getElementById("lockStatus");
const licInfo = document.getElementById("licInfo");
const unlinkBtn = document.getElementById("unlinkBtn");
const deviceList = document.getElementById("deviceList");

// Uninstall-unlink uses a single fixed URL (no fallback possible for a navigation), so
// use the most stable base — the last one in the list (the Railway fallback).
const UNINSTALL_BASE = API_BASES[API_BASES.length - 1];

let mainInited = false;

function setLockStatus(text, cls) { lockStatus.textContent = text; lockStatus.className = cls || "muted"; }
function licValid(lic) { return !!(lic && lic.expiry && Date.now() < new Date(lic.expiry).getTime()); }

// Stable per-install device id (persists in this profile until storage clear / uninstall).
async function getDeviceId() {
  const d = await chrome.storage.local.get("deviceId");
  if (d.deviceId) return d.deviceId;
  const id = (crypto.randomUUID ? crypto.randomUUID() : "dev-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  await chrome.storage.local.set({ deviceId: id });
  return id;
}
const DEVICE_INFO = (navigator.userAgent || "").slice(0, 300);

// Point the browser's "uninstall URL" at the GET unlink endpoint, so removing the
// extension best-effort frees this device's slot. (Often doesn't fire for unpacked
// extensions — the Unlink button is the reliable path.)
function setUninstallUnlink(key, deviceId) {
  try {
    if (chrome.runtime.setUninstallURL && key && deviceId) {
      chrome.runtime.setUninstallURL(`${UNINSTALL_BASE}/api/unlink?key=${encodeURIComponent(key)}&device_id=${encodeURIComponent(deviceId)}`);
    }
  } catch (e) {}
}
function clearUninstallUnlink() { try { chrome.runtime.setUninstallURL && chrome.runtime.setUninstallURL(""); } catch (e) {} }

function fmtLic(lic) {
  let s;
  try {
    const days = Math.max(0, Math.ceil((new Date(lic.expiry).getTime() - Date.now()) / 86400000));
    s = `${days}d left`;
  } catch (e) { s = "Licensed"; }
  if (lic && lic.devices != null) s += ` · ${lic.linked != null ? lic.linked : "?"}/${lic.devices === 0 ? "∞" : lic.devices} dev`;
  return s;
}

function hideDevicePicker() { deviceList.classList.add("hidden"); deviceList.textContent = ""; }
function hideIpReset() { const rv = document.getElementById("ipResetView"); if (rv) rv.classList.add("hidden"); }

function showLock(msg, cls) {
  mainScreen.classList.add("hidden");
  lockScreen.classList.remove("hidden");
  hideDevicePicker();
  hideIpReset();
  if (msg) setLockStatus(msg, cls); else setLockStatus("", "muted");
  licenseKeyEl.focus();
}

function showMain(lic) {
  lockScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  hideDevicePicker();
  licInfo.textContent = fmtLic(lic);
  if (!mainInited) { mainInited = true; initMain(); }
}

// Friendly device label from a stored user-agent string.
function shortDevice(info) {
  info = info || "";
  const os = /Windows/i.test(info) ? "Windows" : /Android/i.test(info) ? "Android"
    : /iPhone|iPad|iOS/i.test(info) ? "iOS" : /Mac/i.test(info) ? "macOS"
    : /Linux/i.test(info) ? "Linux" : "";
  const br = /Edg/i.test(info) ? "Edge" : /OPR|Opera/i.test(info) ? "Opera"
    : /Chrome/i.test(info) ? "Chrome" : /Firefox/i.test(info) ? "Firefox"
    : /Safari/i.test(info) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || (info ? info.slice(0, 32) : "Unknown device");
}
function relTime(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return "just now";
    const m = Math.floor(ms / 60000); if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  } catch (e) { return ""; }
}

// Limit hit on unlock → let the user free a slot by unlinking a linked device, then retry.
function showDevicePicker(key, linked) {
  deviceList.textContent = "";
  const head = document.createElement("p");
  head.className = "dl-head";
  head.textContent = "Unlink a device to free a slot:";
  deviceList.appendChild(head);

  (linked || []).forEach((dev) => {
    const row = document.createElement("div"); row.className = "dl-row";
    const meta = document.createElement("div"); meta.className = "dl-meta";
    const t = document.createElement("div"); t.className = "dl-title"; t.textContent = shortDevice(dev.info);
    const s = document.createElement("div"); s.className = "dl-sub"; s.textContent = "last seen " + relTime(dev.last_seen || dev.linked_at);
    meta.appendChild(t); meta.appendChild(s);

    const btn = document.createElement("button");
    btn.className = "dl-unlink"; btn.type = "button"; btn.textContent = "Unlink";
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "…";
      try {
        await apiFetch("/api/unlink", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, device_id: dev.id }),
        });
      } catch (e) { /* retry will surface any error */ }
      hideDevicePicker();
      doUnlock(); // re-redeem with our device into the freed slot
    });

    row.appendChild(meta); row.appendChild(btn);
    deviceList.appendChild(row);
  });

  deviceList.classList.remove("hidden");
}

async function redeem(key) {
  const device_id = await getDeviceId();
  // Register this install's public key (L1) so the server can verify our signed requests.
  let device_pubkey = "";
  try { if (self.NexaCrypto && self.NexaCrypto.available) device_pubkey = await self.NexaCrypto.getDevicePubB64(); } catch (e) {}
  const r = await apiFetch("/api/redeem", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, device_id, device_info: DEVICE_INFO, device_pubkey }),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/* ───── SMSPool key sync (server-side, keyed to the licence) ─────
   Push our verified key up; pull a newer one down on redeem/validate so the same
   SMSPool key follows the licence onto every platform (Chromium + Orion). */
async function pushSmsToServer(smspoolKey, smspoolValid, smspoolBalance) {
  try {
    const s = await chrome.storage.local.get(["license", "deviceId"]);
    if (!s.license || !s.license.key) return;
    await apiFetch("/api/key/sms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: s.license.key, device_id: s.deviceId,
        smspoolKey: smspoolKey || "", smspoolValid: !!smspoolValid,
        smspoolBalance: smspoolBalance != null ? smspoolBalance : null,
      }),
    });
  } catch (e) { /* offline — the local copy still works on this device */ }
}

// Adopt the server's stored key if it differs from ours (another device set it).
async function applySmsSync(data) {
  try {
    const sp = data && data.smspool;
    if (!sp || !sp.key) return;
    const cur = await chrome.storage.local.get("smspoolKey");
    if (cur.smspoolKey === sp.key) return;
    await chrome.storage.local.set({
      smspoolKey: sp.key, smspoolValid: !!sp.valid,
      smspoolBalance: sp.balance != null ? sp.balance : null,
    });
  } catch (e) {}
}

// On open: trust a still-valid stored license (instant), but re-validate with the server
// in the background so revoked/expired/unlinked devices get kicked.
chrome.storage.local.get("license", (d) => {
  const lic = d && d.license;
  if (licValid(lic)) {
    showMain(lic);
    revalidate(lic.key);
  } else {
    showLock(lic ? "Your access key has expired — enter a new one." : "");
  }
});

async function revalidate(key) {
  try {
    const device_id = await getDeviceId();
    // Re-register our signing pubkey (L1) on every validate so existing installs (redeemed
    // before signing shipped) get registered without re-entering the key.
    let device_pubkey = "";
    try { if (self.NexaCrypto && self.NexaCrypto.available) device_pubkey = await self.NexaCrypto.getDevicePubB64(); } catch (e) {}
    const r = await apiFetch("/api/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, device_id, device_pubkey }),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.valid) {
      await chrome.storage.local.remove("license");
      clearUninstallUnlink();
      const msg = data.reason === "unlinked" ? "This device was unlinked — enter a key to use it here."
        : data.reason === "revoked" ? "This key was revoked — enter a new one."
        : "Access key is no longer valid — please re-enter.";
      showLock(msg, "err");
    } else if (data.expires_at) {
      const lic = { key, expiry: data.expires_at, devices: data.devices, linked: data.linked_count };
      await chrome.storage.local.set({ license: lic });
      licInfo.textContent = fmtLic(lic);
      applySmsSync(data);
    }
  } catch (e) { /* offline — keep trusting the stored expiry */ }
}

async function doUnlock() {
  const key = licenseKeyEl.value.trim().toUpperCase();
  if (!key) { setLockStatus("Enter your key first.", "err"); return; }
  unlockBtn.disabled = true;
  setLockStatus("Checking…", "muted");
  try {
    const { data } = await redeem(key);
    if (data.valid && data.expires_at) {
      const lic = { key, expiry: data.expires_at, devices: data.devices, linked: data.linked_count };
      await chrome.storage.local.set({ license: lic });
      setUninstallUnlink(key, await getDeviceId());
      applySmsSync(data);
      setLockStatus("✓ Unlocked", "ok");
      showMain(lic);
    } else if (data.reason === "device_limit") {
      setLockStatus(`✗ Key in use on ${data.linked_count}/${data.devices} devices.`, "err");
      showDevicePicker(key, data.linked || []);
    } else {
      hideDevicePicker();
      const reason = data.reason === "expired" ? "This key has expired." :
        data.reason === "revoked" ? "This key has been revoked." :
        data.reason === "invalid" ? "Invalid key." : "Could not unlock.";
      setLockStatus("✗ " + reason, "err");
    }
  } catch (e) {
    setLockStatus("Can't reach the licence server. Check your connection.", "err");
  } finally {
    unlockBtn.disabled = false;
  }
}

unlockBtn.addEventListener("click", doUnlock);
licenseKeyEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doUnlock(); });

// Unlink: free this device's slot on the server, then sign out locally.
unlinkBtn.addEventListener("click", async () => {
  unlinkBtn.disabled = true;
  const d = await chrome.storage.local.get(["license", "deviceId"]);
  const lic = d.license;
  if (lic && lic.key && d.deviceId) {
    try {
      await apiFetch("/api/unlink", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: lic.key, device_id: d.deviceId }),
      });
    } catch (e) { /* even if the call fails, sign out locally */ }
  }
  await chrome.storage.local.remove("license");
  clearUninstallUnlink();
  unlinkBtn.disabled = false;
  licenseKeyEl.value = "";
  showLock("Device unlinked — slot freed.", "muted");
});

/* ───────────────────── main UI (wired only once unlocked) ───────────────────── */

function initMain() {
  const clearBtn = document.getElementById("clear");
  const resultEl = document.getElementById("result");
  const keyEl = document.getElementById("smspoolKey");
  const keyToggle = document.getElementById("keyToggle");
  const keySubmit = document.getElementById("keySubmit");
  const keyStatus = document.getElementById("keyStatus");

  function setKeyStatus(text, cls) { keyStatus.textContent = text; keyStatus.className = cls || "muted"; }

  // Load saved SMSPool key + verification state.
  chrome.storage.local.get(["smspoolKey", "smspoolValid", "smspoolBalance"], (d) => {
    const k = d && d.smspoolKey;
    if (k) keyEl.value = k;
    if (d && d.smspoolValid) {
      setKeyStatus(d.smspoolBalance != null && d.smspoolBalance !== "" ? `✓ Valid · Balance $${d.smspoolBalance}` : "✓ Valid key", "saved");
    } else if (k) {
      setKeyStatus("Saved — click Submit to verify", "muted");
    } else {
      setKeyStatus("Not set", "muted");
    }
  });

  let saveTimer = 0;
  keyEl.addEventListener("input", () => {
    setKeyStatus("Not verified — click Submit", "muted");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const val = keyEl.value.trim();
      if (val) {
        chrome.storage.local.set({ smspoolKey: val, smspoolValid: false, smspoolBalance: null });
      } else {
        chrome.storage.local.remove("smspoolKey");
        chrome.storage.local.set({ smspoolValid: false, smspoolBalance: null });
        setKeyStatus("Not set", "muted");
        pushSmsToServer("", false, null); // sync the removal to the other devices
      }
    }, 300);
  });

  keyToggle.addEventListener("click", () => {
    const show = keyEl.type === "password";
    keyEl.type = show ? "text" : "password";
    keyToggle.textContent = show ? "Hide" : "Show";
  });

  function showValid(bal, refreshing) {
    const b = bal != null && bal !== "" ? `✓ Valid · Balance $${bal}` : "✓ Valid key";
    setKeyStatus(refreshing ? b + " · updating…" : b, "saved");
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.smspoolBalance && keyStatus.classList.contains("saved")) showValid(ch.smspoolBalance.newValue);
    // A key synced down from another device → reflect it in the field + status.
    if (ch.smspoolKey && ch.smspoolKey.newValue && ch.smspoolKey.newValue !== keyEl.value) {
      keyEl.value = ch.smspoolKey.newValue;
    }
    if (ch.smspoolValid && ch.smspoolValid.newValue) {
      chrome.storage.local.get("smspoolBalance", (d) => showValid(d && d.smspoolBalance));
    }
  });
  chrome.storage.local.get(["smspoolValid", "smspoolBalance"], (d) => {
    if (!(d && d.smspoolValid)) return;
    showValid(d.smspoolBalance, true);
    const tick = () => chrome.runtime.sendMessage({ type: "refreshBalance" }, (res) => {
      if (!chrome.runtime.lastError && res) showValid(res.balance);
    });
    tick();
    const iv = setInterval(tick, 60000);
    window.addEventListener("unload", () => clearInterval(iv));
  });

  keySubmit.addEventListener("click", async () => {
    const key = keyEl.value.trim();
    if (!key) { setKeyStatus("Enter a key first", "err"); return; }
    keySubmit.disabled = true;
    setKeyStatus("Checking…", "muted");
    try {
      const fd = new FormData();
      fd.append("key", key);
      const r = await fetch("https://api.smspool.net/request/balance", { method: "POST", body: fd });
      let data = {};
      try { data = await r.json(); } catch (_) {}
      const valid = r.status === 200 && data && Object.prototype.hasOwnProperty.call(data, "balance");
      if (valid) {
        const bal = data.balance === "" || data.balance == null ? null : data.balance;
        await chrome.storage.local.set({ smspoolKey: key, smspoolValid: true, smspoolBalance: bal });
        setKeyStatus(bal != null ? `✓ Valid · Balance $${bal}` : "✓ Valid key", "saved");
        pushSmsToServer(key, true, bal); // sync the verified key to this licence's other devices
      } else {
        await chrome.storage.local.set({ smspoolKey: key, smspoolValid: false, smspoolBalance: null });
        const why = (data && (data.message || data.error)) ? `: ${data.message || data.error}` : ` (HTTP ${r.status})`;
        setKeyStatus("✗ Invalid key" + why, "err");
      }
    } catch (e) {
      setKeyStatus("Network error: " + ((e && e.message) || e), "err");
    } finally {
      keySubmit.disabled = false;
    }
  });

  function setResult(text, cls) { resultEl.textContent = text; resultEl.className = cls || "muted"; }

  /* ───────────────────────── Your IP + Reset IP ───────────────────────── */
  const ipValue = document.getElementById("ipValue");
  const ipStatus = document.getElementById("ipStatus");
  const resetIpBtn = document.getElementById("resetIp");
  const ipWarn = document.getElementById("ipWarn");
  const ipWarnReset = document.getElementById("ipWarnReset");
  const ipWarnContinue = document.getElementById("ipWarnContinue");
  const ipResetView = document.getElementById("ipResetView");
  const ipResetCurrent = document.getElementById("ipResetCurrent");
  const ipResetCancel = document.getElementById("ipResetCancel");

  let currentIp = null, ipSeen = false, pollTimer = 0;

  async function getIp() {
    const r = await apiFetch("/api/ip");
    const d = await r.json().catch(() => ({}));
    if (d && d.ip) __rooIp = d.ip; // keep the app-key header's IP component fresh
    return d;
  }

  async function refreshIp() {
    ipValue.textContent = "checking…";
    ipStatus.textContent = "";
    try {
      const d = await getIp();
      currentIp = d.ip || null;
      ipSeen = !!d.seen;
      ipValue.textContent = d.ip || "unavailable";
      if (d.seen) { ipStatus.textContent = "⚠ This IP has been used before — Reset IP for a better experience."; ipStatus.className = "note warn"; }
      else { ipStatus.textContent = "✓ Fresh IP — good to go."; ipStatus.className = "note ok"; }
    } catch (e) {
      ipValue.textContent = "unavailable";
      ipStatus.textContent = "Couldn't reach the IP service.";
      ipStatus.className = "note";
    }
  }

  function showResetView(fromIp) {
    ipResetCurrent.textContent = fromIp || currentIp || "…";
    mainScreen.classList.add("hidden");
    ipResetView.classList.remove("hidden");
  }
  function hideResetView() { ipResetView.classList.add("hidden"); mainScreen.classList.remove("hidden"); }
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; } }

  async function startReset() {
    ipWarn.classList.add("hidden");
    await chrome.storage.local.set({ ipResetFrom: currentIp || "" });
    showResetView(currentIp);
    pollReset();
  }

  // Polls until the IP differs from the one at reset time. Tolerates being offline
  // (airplane mode) — failed checks are ignored and it keeps trying. State is persisted,
  // so closing/reopening the popup resumes the wait and re-checks immediately.
  async function pollReset() {
    stopPoll();
    const s = await chrome.storage.local.get("ipResetFrom");
    if (s.ipResetFrom == null) { hideResetView(); return; } // cancelled
    try {
      const cur = await getIp();
      if (cur.ip && cur.ip !== s.ipResetFrom) {
        await chrome.storage.local.remove("ipResetFrom");
        currentIp = cur.ip; ipSeen = !!cur.seen;
        hideResetView();
        await refreshIp();
        return;
      }
    } catch (e) { /* offline — keep waiting */ }
    pollTimer = setTimeout(pollReset, 4000);
  }

  resetIpBtn.addEventListener("click", startReset);
  ipWarnReset.addEventListener("click", startReset);
  ipResetCancel.addEventListener("click", async () => {
    stopPoll();
    await chrome.storage.local.remove("ipResetFrom");
    hideResetView();
    refreshIp();
  });

  // Resume an in-progress reset if the popup was reopened mid-wait; else show the IP.
  chrome.storage.local.get("ipResetFrom", (d) => {
    if (d.ipResetFrom != null) { showResetView(d.ipResetFrom); pollReset(); }
    else { refreshIp(); }
  });

  /* ───────────────────────── Clear data ───────────────────────── */

  function doClear() {
    clearBtn.disabled = true;
    setResult("Clearing…", "muted");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = (tabs && tabs[0]) || {};
      chrome.runtime.sendMessage({ type: "clearData", tabId: tab.id, tabUrl: tab.url }, (res) => {
        clearBtn.disabled = false;
        if (chrome.runtime.lastError) { setResult("Failed: " + chrome.runtime.lastError.message, "err"); return; }
        if (!res || !res.ok) {
          setResult(res && res.error === "locked" ? "Locked — re-enter your access key." : "Failed: " + ((res && res.error) || "unknown error"), "err");
          return;
        }
        const base =
          `✓ Cleared — ${res.cookiesRemoved} cookie${res.cookiesRemoved === 1 ? "" : "s"} ` +
          `and storage for ${res.originsCleared} origin${res.originsCleared === 1 ? "" : "s"}.`;
        if (res.overlay) {
          setResult(base + " Tab frozen — choose an option on the page.", "ok");
          setTimeout(() => window.close(), 600);
        } else {
          setResult(base + " (Open a deliveroo.co.uk tab to get the next-step prompt.)", "ok");
        }
      });
    });
  }

  function logIp() {
    chrome.storage.local.get(["license", "deviceId"], (s) => {
      apiFetch("/api/ip/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: s.license && s.license.key, device_id: s.deviceId }),
      }).catch(() => {});
    });
  }

  function proceedClear() {
    ipWarn.classList.add("hidden");
    logIp();           // mark this IP as used
    doClear();
  }

  clearBtn.addEventListener("click", async () => {
    ipWarn.classList.add("hidden");
    // fresh IP check — warn (don't block) if it's been used before
    let seen = ipSeen;
    try { const d = await getIp(); seen = !!d.seen; currentIp = d.ip || currentIp; } catch (e) {}
    if (seen) { ipWarn.classList.remove("hidden"); return; }
    proceedClear();
  });
  ipWarnContinue.addEventListener("click", proceedClear);
}

// background.js — Clear data + freeze + glassmorphic overlay, and the
// "Make a new Deliveroo account" flow (Manual = go to login, Auto = server-proxied
// SMSPool OTP → Bearer token → best-effort web login).
//
// Header spoofing on api.uk.deliveroo.com is declarative (rules.json).

// Shared device-identity + request-signing module (L1). MUST load first (synchronous) so
// NexaCrypto exists before any key-API call signs a request.
try { importScripts("crypto.js"); } catch (e) { /* crypto.js absent → signing degrades to off */ }

// License gate: the extension is locked until a valid NEXA-DROO key is redeemed
// (see popup). Everything user-facing starts from the clearData message, so gating it
// here covers the whole flow.
async function isLicensed() {
  const d = await chrome.storage.local.get("license");
  const l = d && d.license;
  return !!(l && l.expiry && Date.now() < new Date(l.expiry).getTime());
}

const COOKIE_DOMAINS = ["deliveroo.com", "deliveroo.co.uk"];
const LOGIN_URL = "https://deliveroo.co.uk/login";

const SEED_ORIGINS = [
  "https://deliveroo.co.uk", "https://www.deliveroo.co.uk",
  "https://deliveroo.com", "https://www.deliveroo.com",
  "https://api.uk.deliveroo.com", "https://co-m.uk.deliveroo.com",
  "https://edge.deliveroo.com",
];

const BLOCK_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
];

// ── Deliveroo / SMSPool constants (mirrored from bot.py) ─────────────────────
const ROO_BASE = "https://co-m.uk.deliveroo.com";
const ROO_AUTH = ROO_BASE + "/orderapp/v1";
const IOS_UA = "Deliveroo-OrderApp/3.308.2 (iPhone10,5; iOS16.7.12; Release; en_GB; 103039)";
const SMSPOOL = "https://api.smspool.net";
const SMSPOOL_SERVICE_ID = "258";
const SMSPOOL_COUNTRY = "1";
const UA_RULE_ID = 90001;

/* ── capability detection — degrade gracefully on mobile (Orion / Safari WE / FF Android) ──
   Desktop Chromium has the lot, so it takes the DNR fast-path. Mobile hosts that lack
   declarativeNetRequest / browsingData fall back to page-context + cookies, which work
   without those APIs. Each capability is probed independently. */
// dnr/dnrSession are GETTERS — declarativeNetRequest is an OPTIONAL permission (so the
// manifest installs on browsers like Orion that don't support it), and may be granted at
// runtime on Chrome. Live-checking keeps every call site correct after a late grant.
const CAP = {
  get dnr() { return !!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules); },
  get dnrSession() { return !!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules); },
  browsingData: !!(chrome.browsingData && chrome.browsingData.remove),
  alarms: !!(chrome.alarms && chrome.alarms.create),
};

/* ───────────────────────────── clear ───────────────────────────── */

function cookieUrl(c) {
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  return `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`;
}

async function clearCookies() {
  const seen = new Set();
  let removed = 0;
  for (const domain of COOKIE_DOMAINS) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const c of cookies) {
      const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      seen.add(`https://${host}`);
      try {
        await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
        removed++;
      } catch (_) {}
    }
  }
  return { removed, originsFromCookies: [...seen] };
}

async function clearStorage(origins, tabId) {
  if (CAP.browsingData) {
    await chrome.browsingData.remove(
      { origins },
      { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true, cacheStorage: true, fileSystems: true, webSQL: true }
    );
    return;
  }
  // Fallback (no browsingData): ask content.js to wipe the current tab's page storage.
  if (typeof tabId === "number") {
    await chrome.tabs.sendMessage(tabId, { type: "storageWipe" }).catch(() => {});
  }
}

async function clearAll(tabId) {
  const { removed, originsFromCookies } = await clearCookies();
  const origins = [...new Set([...SEED_ORIGINS, ...originsFromCookies])];
  await clearStorage(origins, tabId);
  return { cookiesRemoved: removed, originsCleared: origins.length };
}

/* ─────────────────────────── freeze tab ─────────────────────────── */

function freezeTab(tabId) {
  if (!CAP.dnrSession) return Promise.resolve(); // mobile: no network freeze; overlay still covers the page
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId, priority: 100,
      action: { type: "block" },
      condition: { tabIds: [tabId], resourceTypes: BLOCK_RESOURCE_TYPES },
    }],
  });
}
function unfreezeTab(tabId) {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId], addRules: [] });
}

/* ───────── always-on header spoof (was rules.json — now runtime session rules) ─────────
   Registered at startup instead of via the manifest's static `declarative_net_request`
   ruleset, which some browsers (e.g. Orion) reject at install time. Same effect on Chrome;
   a no-op where DNR isn't available. */
const HEADER_RULE_IDS = [70001, 70002];
const XROO_HEADERS = [
  { header: "x-roo-platform", operation: "set", value: "iOS" },
  { header: "x-roo-client", operation: "remove" },
];
function ensureHeaderRules() {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: HEADER_RULE_IDS,
    addRules: [
      {
        id: 70001, priority: 1,
        action: { type: "modifyHeaders", requestHeaders: XROO_HEADERS },
        condition: { requestDomains: ["api.uk.deliveroo.com"], resourceTypes: BLOCK_RESOURCE_TYPES },
      },
      {
        id: 70002, priority: 1,
        action: { type: "modifyHeaders", requestHeaders: XROO_HEADERS },
        condition: { urlFilter: "||deliveroo.co.uk/api/", resourceTypes: BLOCK_RESOURCE_TYPES },
      },
    ],
  }).catch(() => {});
}
ensureHeaderRules();
chrome.runtime.onInstalled.addListener(() => ensureHeaderRules());
chrome.runtime.onStartup.addListener(() => ensureHeaderRules());

/* ─────────────── iOS User-Agent for our co-m background fetches ─────────────── */
// fetch() can't set User-Agent, so a DNR rule stamps it on co-m requests.
function enableIosUa() {
  if (!CAP.dnrSession) return Promise.resolve(); // mobile: can't override UA; the API calls still go through on the host UA
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [UA_RULE_ID],
    addRules: [{
      id: UA_RULE_ID, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "User-Agent", operation: "set", value: IOS_UA }] },
      condition: { requestDomains: ["co-m.uk.deliveroo.com"], resourceTypes: ["xmlhttprequest", "other", "ping", "csp_report"] },
    }],
  });
}
function disableIosUa() {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [UA_RULE_ID], addRules: [] });
}

/* ───────── persistent "logged-in" auth header (the new account's bearer) ───────── */
// A DYNAMIC rule (survives restarts) that stamps `Authorization: Bearer <token>` on the
// Deliveroo API hosts, so once an account is auto-created, refreshing deliveroo.co.uk
// authenticates as that account. Cleared on "Clear data" (logout) or when token is null.
const AUTH_RULE_ID = 80001;   // api.uk / co-m hosts
const AUTH_RULE_ID2 = 80002;  // same-origin deliveroo.co.uk/api/ path (the web app's calls)
function setAuthHeader(token) {
  // No-op without DNR — on mobile the consumer_auth_token COOKIE carries the session, so
  // login still works; this header is the desktop bonus the web app's API calls use.
  if (!CAP.dnr) return Promise.resolve();
  const authAction = { type: "modifyHeaders", requestHeaders: [{ header: "Authorization", operation: "set", value: "Bearer " + token }] };
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [AUTH_RULE_ID, AUTH_RULE_ID2],
    addRules: token ? [
      {
        id: AUTH_RULE_ID, priority: 2, action: authAction,
        condition: { requestDomains: ["api.uk.deliveroo.com", "co-m.uk.deliveroo.com"], resourceTypes: ["xmlhttprequest", "other"] },
      },
      {
        id: AUTH_RULE_ID2, priority: 2, action: authAction,
        condition: { urlFilter: "||deliveroo.co.uk/api/", resourceTypes: ["xmlhttprequest", "other"] },
      },
    ] : [],
  });
}

/* ───────── web login (deliveroo.co.uk same-origin auth endpoints) ───────── */
// Replicates the site's own login: GET /api/auth/props (csrf) → POST /api/auth/login
// {email,password}. The 200 sets consumer_auth_token + session cookies in the browser
// jar (shared with the tab), so refreshing deliveroo.co.uk is logged in. The bearer
// token to keep is the consumer_auth_token cookie value.
const ORIGIN_RULE_ID = 80003;
function enableAuthOrigin() {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules: [{
      id: ORIGIN_RULE_ID, priority: 3,
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "Origin", operation: "set", value: "https://deliveroo.co.uk" },
        { header: "Referer", operation: "set", value: "https://deliveroo.co.uk/login?redirect=%2F" },
      ] },
      condition: { urlFilter: "||deliveroo.co.uk/api/auth/", resourceTypes: ["xmlhttprequest", "other"] },
    }],
  });
}
function disableAuthOrigin() {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ORIGIN_RULE_ID], addRules: [] });
}

function getCookie(url, name) {
  return chrome.cookies.get({ url, name }).then((c) => (c ? c.value : null)).catch(() => null);
}

function webAuthHeaders(rooGuid, rooSession) {
  return {
    "accept": "application/json, application/vnd.api+json",
    "content-type": "application/json",
    "x-roo-platform": "iOS",
    "x-roo-country": "uk",
    "x-roo-guid": rooGuid || "",
    "x-roo-sticky-guid": rooGuid || "",
    "x-roo-session-guid": rooSession || "",
    "x-roo-client-referer": "",
    "x-roo-external-device-id": "",
  };
}

// Returns the consumer_auth_token (bearer) on success, throws otherwise.
async function webApiLogin(email, password) {
  await setAuthHeader(null).catch(() => {}); // login must go out with no Authorization header
  await enableAuthOrigin();
  try {
    // 1) seed __cf_bm + roo_guid + roo_session_guid + roo_super_properties + locale
    await fetch("https://deliveroo.co.uk/login?redirect=%2F", { credentials: "include" });
    const rooGuid = await getCookie("https://deliveroo.co.uk", "roo_guid");
    const rooSession = await getCookie("https://deliveroo.co.uk", "roo_session_guid");
    const H = webAuthHeaders(rooGuid, rooSession);

    // 2) csrf token
    const pr = await fetch("https://deliveroo.co.uk/api/auth/props?redirect=%2F", { credentials: "include", headers: H });
    if (!pr.ok) throw new Error("props " + pr.status);
    const props = await pr.json().catch(() => ({}));
    const csrf = props.csrf_token;
    if (!csrf) throw new Error("no csrf token");

    // 3) login
    const lr = await fetch("https://deliveroo.co.uk/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: Object.assign({}, H, { "x-csrf-token": csrf, "x_roo_challenge_support": "passcode" }),
      body: JSON.stringify({ email, password, page_in_progress: "login" }),
    });
    if (!lr.ok) {
      const t = await lr.text().catch(() => "");
      throw new Error("login " + lr.status + (t ? ": " + t.slice(0, 120) : ""));
    }

    // 4) the consumer_auth_token cookie is the bearer token
    const cat = await getCookie("https://deliveroo.co.uk", "consumer_auth_token");
    if (!cat) throw new Error("logged in but no consumer_auth_token cookie");
    return cat;
  } finally {
    await disableAuthOrigin().catch(() => {});
  }
}

// Mobile fallback: run the same login from the deliveroo.co.uk PAGE context, where the
// browser sets Origin/Referer/cookies natively (no DNR needed). Requires the active tab
// to be on deliveroo.co.uk and not frozen — which holds on mobile (freeze needs DNR).
// Page-context web login now runs in content.js; we just message it and read the result.
async function webApiLoginPage(tabId, email, password) {
  const r = await chrome.tabs.sendMessage(tabId, { type: "pageLogin", email, password }).catch(() => null);
  if (!r || !r.ok) throw new Error("page login " + ((r && (r.step ? r.step + " " : "") + (r.status || "")) || "failed") + (r && r.error ? ": " + r.error : ""));
  const cat = r.token || (await getCookie("https://deliveroo.co.uk", "consumer_auth_token"));
  if (!cat) throw new Error("logged in but no consumer_auth_token");
  return cat;
}

/* ───────────────────────── identity helpers ───────────────────────── */

function randStr(n, alphabet) {
  const a = alphabet || "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.getRandomValues(new Uint8Array(n));
  let out = "";
  for (let i = 0; i < n; i++) out += a[buf[i] % a.length];
  return out;
}
const FIRST = ["Alex","Jordan","Casey","Riley","Morgan","Taylor","Avery","Quinn","Skyler","Cameron"];
const LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Wilson","Taylor"];
function pick(arr) { return arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length]; }

function genEmail() {
  // random 12–14 lowercase alphanumeric local part on nexaserve.uk
  const n = 12 + (crypto.getRandomValues(new Uint8Array(1))[0] % 3);
  return randStr(n, "abcdefghijklmnopqrstuvwxyz0123456789") + "@nexaserve.uk";
}
function genIdentity() {
  const first = pick(FIRST), last = pick(LAST);
  const password = "Az9!" + randStr(10, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  return { first, last, email: genEmail(), password };
}

// Key API bases (same as the popup's config) — used to reserve a unique email.
const KEY_API_BASES = ["https://deliveroo.nexaserve.uk", "https://roo-ext-production.up.railway.app"];
// App key for the `x-app-key` header — base64("<appKey>|<ip>"); must match config.js
// NEXA_APP_KEY + server APP_KEY. __rooBgIp is refreshed from the server's ip_mismatch reply.
const NEXA_APP_KEY = "NEXA-DROO-APP-7kyM77W-_01UYy42NUpJZ5cS";
let __rooBgIp = "";
function appKeyHeader() {
  return (typeof btoa === "function") ? btoa(NEXA_APP_KEY + "|" + (__rooBgIp || "")) : "";
}
// Per-device signature headers (L1) for a key-API call. Harmless when the server isn't enforcing
// (REQUIRE_SIG off); required once it is. Empty object if NexaCrypto/WebCrypto is unavailable.
async function signHeaders(method, path, bodyStr) {
  try {
    if (!self.NexaCrypto || !self.NexaCrypto.available) return {};
    const d = await chrome.storage.local.get("deviceId");
    const s = await self.NexaCrypto.signRequest(method || "GET", path, bodyStr || "");
    return { "x-roo-ts": s.ts, "x-roo-nonce": s.nonce, "x-roo-sig": s.sig, "x-roo-device": (d && d.deviceId) || "" };
  } catch (e) { return {}; }
}
async function keyApiFetch(path, opts) {
  opts = opts || {};
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const h = appKeyHeader();
    const sig = await signHeaders(opts.method || "GET", path, typeof opts.body === "string" ? opts.body : "");
    const o = Object.assign({}, opts, { headers: Object.assign({}, opts.headers, sig, h ? { "x-app-key": h } : {}) });
    let retry = false;
    for (const base of KEY_API_BASES) {
      try {
        const res = await fetch(base + path, o);
        if (res.status === 403 && attempt === 0) {
          const d = await res.clone().json().catch(() => ({}));
          if (d && d.error === "ip_mismatch" && d.ip) { __rooBgIp = d.ip; retry = true; break; }
        }
        return res;
      } catch (e) { lastErr = e; }
    }
    if (!retry) break;
  }
  throw lastErr || new Error("key API unreachable");
}
// Reserve a fresh email with the API so it's never reused by anyone (across users/devices).
// Retries on conflict; if the API is unreachable, falls back to the random email (a
// collision among random 12–14 char locals is astronomically unlikely).
async function claimEmail() {
  for (let i = 0; i < 6; i++) {
    const email = genEmail();
    try {
      const r = await keyApiFetch("/api/email/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      if (r.ok) return email;             // claimed (200)
      if (r.status !== 409) return email; // unexpected error — use it anyway
      // 409 taken → generate another
    } catch (e) { return email; }         // API down — use the random email
  }
  return genEmail();
}

function rooHeaders() {
  const guid = crypto.randomUUID().toUpperCase();
  return {
    "Accept": "*/*",
    "Content-Type": "application/json",
    "x-roo-app-version": "3.308.2",
    "x-roo-country": "uk",
    "x-roo-platform": "iOS",
    "x-roo-rooblocks-version": "5.0.0",
    "x-roo-guid": guid,
    "x-roo-sticky-guid": guid,
    "request-id": "req_" + randStr(27, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
  };
}

async function rooPost(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: rooHeaders(),
    body: JSON.stringify(body),
    credentials: "include",
  });
  let data = null;
  const text = await resp.text().catch(() => "");
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data, text, headers: resp.headers };
}

function extractToken(data, headers) {
  const KEYS = ["token", "access_token", "auth_token", "jwt", "session_token"];
  if (data && typeof data === "object") {
    for (const k of KEYS) if (typeof data[k] === "string" && data[k]) return data[k];
    for (const c of ["session", "auth", "data"]) {
      const n = data[c];
      if (n && typeof n === "object") for (const k of KEYS) if (typeof n[k] === "string" && n[k]) return n[k];
    }
  }
  if (headers) {
    const a = headers.get("authorization") || headers.get("Authorization");
    if (a && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, "").trim();
  }
  return null;
}

/* ─────────────────────────── voucher ─────────────────────────── */

const VOUCHER_PASTEBIN = "https://pastebin.com/raw/ycf33H7N";

// One-line raw paste; the code updates regularly so we read it fresh each run.
async function fetchVoucherCode() {
  const r = await fetch(VOUCHER_PASTEBIN, { cache: "no-store" });
  if (!r.ok) throw new Error("pastebin " + r.status);
  const t = await r.text();
  return (t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "").trim();
}

// 1:1 with bot.py apply_voucher: Basic base64(user_id:orderapp_ios,token) + {redemption_code, page}.
function basicAuth(userId, token) {
  return "Basic " + btoa(`${userId}:orderapp_ios,${token}`);
}
async function applyVoucher(userId, token, code) {
  const headers = rooHeaders();
  headers["Authorization"] = basicAuth(userId, token);
  const resp = await fetch(`${ROO_AUTH}/users/${encodeURIComponent(userId)}/vouchers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ redemption_code: code, page: "account" }),
    credentials: "include",
  });
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data, text };
}

/* ─────────────────────────── SMSPool ─────────────────────────── */

async function smspoolPost(endpoint, params) {
  const resp = await fetch(`${SMSPOOL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await resp.text().catch(() => "");
  try { return JSON.parse(text); } catch (_) { return { success: 0, message: text || `HTTP ${resp.status}` }; }
}

/* ───────── account OTP via the licence-gated server proxy (L2) ─────────
   The number is rented and polled by the SERVER using the licence's stored SMSPool key, so a
   client without a valid licence can't get an OTP and therefore can't complete a signup. The
   Deliveroo signup itself still runs here in the browser, on the user's own residential IP — the
   server never touches Deliveroo. buildPhone now lives server-side. */
async function getLicenseKey() {
  const d = await chrome.storage.local.get("license");
  return (d && d.license && d.license.key) || "";
}
async function otpRent() {
  const key = await getLicenseKey();
  if (!key) throw new Error("No licence — open the popup and redeem your key.");
  const r = await keyApiFetch("/api/account/otp/rent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) {
    if (d && d.reason === "no_smspool_key") throw new Error("No SMSPool key on your licence — set it in the popup first.");
    throw new Error("SMSPool: " + ((d && (d.message || d.reason)) || ("couldn't rent a number — check your SMSPool key / balance")));
  }
  return { phone: d.phone, orderId: d.orderId };
}
async function otpCheck(orderId) {
  const key = await getLicenseKey();
  const r = await keyApiFetch("/api/account/otp/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, orderId }) });
  const d = await r.json().catch(() => ({}));
  return { code: d && d.code ? d.code : null, status: d && d.status };
}
// Cancels the rented number (SMSPool refunds an un-received number). Returns { ok, cancelled }
// so the caller can honestly tell the user whether the balance was refunded.
async function otpCancel(orderId) {
  try {
    const key = await getLicenseKey();
    const r = await keyApiFetch("/api/account/otp/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, orderId }) });
    return await r.json().catch(() => ({ ok: false, cancelled: false }));
  } catch (e) { return { ok: false, cancelled: false }; }
}

/* ─────────────────── auto account creation pipeline ─────────────────── */

function sendStep(tabId, key, text, state) {
  chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "step", key, text, state }).catch(() => {});
}

async function autoCreate(tabId) {
  const cfg = await chrome.storage.local.get(["smspoolKey", "smspoolValid"]);
  const key = cfg && cfg.smspoolKey;
  if (!key || !cfg.smspoolValid) {
    chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "error", message: "SMSPool key not verified — open the extension popup, enter your key and click Submit." }).catch(() => {});
    return;
  }

  const id = genIdentity();
  id.email = await claimEmail(); // reserve a unique @nexaserve.uk email via the API
  let orderId = null;
  await enableIosUa();
  try {
    // 1) rent a number (server-side, licence-gated — see otpRent)
    sendStep(tabId, "rent", "Renting a number (SMSPool)…", "run");
    const num = await otpRent();
    orderId = num.orderId;
    sendStep(tabId, "rent", `Number rented: ${num.phone}`, "ok");

    // 2) seed a Cloudflare session
    sendStep(tabId, "init", "Initialising session…", "run");
    await rooPost(ROO_AUTH + "/session", { first_install: 1 });
    sendStep(tabId, "init", "Session ready", "ok");

    // 3) trigger the verification SMS
    sendStep(tabId, "sms", "Requesting SMS code…", "run");
    const sent = await rooPost(ROO_BASE + "/consumer/send_verification_code", {
      verification_address: num.phone, verification_method: "sms", verification_trigger: "account_creation",
    });
    if (!sent.ok) throw new Error("Deliveroo refused the SMS request (" + sent.status + ")");
    sendStep(tabId, "sms", "SMS requested", "ok");

    // 4) wait for the code (1 min). If it doesn't arrive, cancel the number — SMSPool refunds an
    //    un-received number — and surface a "try again" so the user can rent a fresh one.
    sendStep(tabId, "wait", "Waiting for the SMS code…", "run");
    let code = null;
    const deadline = Date.now() + 60000; // 1 minute
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const r = await otpCheck(orderId);
      if (r.code) { code = r.code; break; }
    }
    if (!code) {
      sendStep(tabId, "wait", "No SMS after 1 minute — cancelling the number…", "fail");
      const cancel = orderId ? await otpCancel(orderId) : { cancelled: false };
      orderId = null; // cancelled here → don't let the catch re-cancel
      const refunded = !!(cancel && cancel.cancelled);
      chrome.tabs.sendMessage(tabId, {
        __rooAuto: true, kind: "error", title: "SMS didn't arrive",
        message: refunded
          ? "The verification SMS didn't arrive within 1 minute, so the number was cancelled and your SMSPool balance refunded. Tap “Try again” to rent a fresh number."
          : "The verification SMS didn't arrive within 1 minute, so the number was released. Tap “Try again” to rent a fresh number.",
      }).catch(() => {});
      return; // finally{} still runs (disableIosUa)
    }
    sendStep(tabId, "wait", `Code received: ${code}`, "ok");

    // 5) verify the code
    sendStep(tabId, "verify", "Verifying code…", "run");
    const ver = await rooPost(ROO_BASE + "/consumer/verify_code", {
      verification_address: num.phone, verification_code: String(code), verification_method: "sms", verification_trigger: "account_creation",
    });
    if (!ver.ok) throw new Error("Code verification failed (" + ver.status + ")");
    const secret = (ver.data && (ver.data.verification_secret || ver.data.verification_token)) || "confirmed";
    sendStep(tabId, "verify", "Verified", "ok");

    // 6) register
    sendStep(tabId, "register", "Creating the account…", "run");
    const regBody = {
      email: id.email, password: id.password, first_name: id.first, last_name: id.last,
      client_type: "orderapp_ios",
      marketing_preferences: { marketing_sms: false, marketing_email: false, marketing_push: false },
    };
    if (secret && secret !== "confirmed") regBody.verification_secret = secret;
    const reg = await rooPost(ROO_AUTH + "/users", regBody);
    if (!reg.ok) throw new Error("Registration failed (" + reg.status + "): " + (reg.text || "").slice(0, 160));
    let userId = reg.data && (reg.data.id || reg.data.user_id);
    let token = extractToken(reg.data, reg.headers);

    // 7) fall back to a login if the register didn't return a token
    if (!token) {
      sendStep(tabId, "register", "Account made — signing in…", "run");
      const log = await rooPost(ROO_AUTH + "/sessions", { email: id.email, password: id.password, client_type: "orderapp_ios" });
      if (log.ok) {
        userId = userId || (log.data && (log.data.user_id || log.data.id || log.data.customer_id));
        token = extractToken(log.data, log.headers);
      }
    }
    if (!token) throw new Error("Account created but no bearer token returned");
    sendStep(tabId, "register", "Account created", "ok");

    const account = { email: id.email, password: id.password, phone: num.phone, userId: userId || null, token };

    // 8) auto-apply the current voucher (non-fatal — never fails the account)
    sendStep(tabId, "voucher", "Applying voucher…", "run");
    try {
      const code = await fetchVoucherCode();
      if (!code) throw new Error("no code in paste");
      if (!userId) throw new Error("no user id to apply against");
      const v = await applyVoucher(userId, token, code);
      if (v.ok) {
        account.voucher = code;
        sendStep(tabId, "voucher", `Voucher applied: ${code}`, "ok");
      } else {
        const why = (v.data && (v.data.message || v.data.error)) || ("HTTP " + v.status);
        sendStep(tabId, "voucher", `Voucher not applied (${why})`, "fail");
      }
    } catch (e) {
      sendStep(tabId, "voucher", "Voucher skipped: " + String((e && e.message) || e), "fail");
    }

    // 9) log into the website (sets consumer_auth_token + session cookies in the jar).
    //    Desktop (DNR): background fetch + Origin/Referer DNR rule, keeps the tab frozen.
    //    Mobile (no DNR): run it from the page context (native headers, tab isn't frozen).
    sendStep(tabId, "weblogin", "Logging into the website…", "run");
    try {
      const cat = CAP.dnrSession
        ? await webApiLogin(id.email, id.password)
        : await webApiLoginPage(tabId, id.email, id.password);
      account.consumerAuthToken = cat;
      account.webLoginOk = true;
      // The bearer token to keep is the consumer_auth_token cookie value.
      await setAuthHeader(cat).catch(() => {});
      sendStep(tabId, "weblogin", "Logged in — session cookies applied", "ok");
    } catch (e) {
      account.webLoginOk = false;
      sendStep(tabId, "weblogin", "Web login failed: " + String((e && e.message) || e), "fail");
    }

    await chrome.storage.local.set({ activeAccount: account });
    chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "done", account }).catch(() => {});
  } catch (err) {
    if (orderId) otpCancel(orderId);
    chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "error", message: String((err && err.message) || err) }).catch(() => {});
  } finally {
    await disableIosUa().catch(() => {});
  }
}

/* ───────────── best-effort: log the live web UI in ───────────── */

// The session cookies + bearer were already applied during auto-create; just unfreeze
// and open the site so it loads logged-in (or the login page if web login didn't take).
function webLogin(tabId, account) {
  const url = account && account.webLoginOk ? "https://deliveroo.co.uk/" : "https://deliveroo.co.uk/login";
  unfreezeTab(tabId).finally(() => chrome.tabs.update(tabId, { url }));
}

/* ─────────────────────── glassmorphic overlay ─────────────────────── */

function showOverlay(tabId) {
  // content.js (declared content script) renders the overlay on this message.
  return chrome.tabs.sendMessage(tabId, { type: "showOverlay" });
}

/* ──────────────────────────── messages ──────────────────────────── */

function isDeliveroo(url) {
  return !!url && /^https?:\/\/([^/]+\.)?deliveroo\.(co\.uk|com)(\/|$)/i.test(url);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "clearData") {
    (async () => {
      if (!(await isLicensed())) { sendResponse({ ok: false, error: "locked" }); return; }
      const tabId = msg.tabId;
      const onRoo = typeof tabId === "number" && isDeliveroo(msg.tabUrl);
      const summary = await clearAll(onRoo ? tabId : undefined);
      await setAuthHeader(null).catch(() => {}); // logout: remove any injected bearer token
      await chrome.storage.local.remove("activeAccount").catch(() => {});
      let overlay = false;
      if (onRoo) {
        try { await freezeTab(tabId); await showOverlay(tabId); overlay = true; } catch (_) {}
      }
      sendResponse({ ok: true, overlay, ...summary });
    })().catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "refreshBalance") {
    refreshBalance().then((bal) => sendResponse({ balance: bal })).catch(() => sendResponse({ balance: null }));
    return true;
  }

  if (msg.type === "reinitDnr") { ensureHeaderRules(); return; } // DNR just granted on Chrome

  if (msg.__rooClear && sender.tab && typeof sender.tab.id === "number") {
    const tabId = sender.tab.id;
    if (msg.action === "newAccountManual") {
      unfreezeTab(tabId).finally(() => chrome.tabs.update(tabId, { url: LOGIN_URL }));
    } else if (msg.action === "autoCreate") {
      autoCreate(tabId); // streams progress via tabs.sendMessage
    } else if (msg.action === "webLogin") {
      chrome.storage.local.get("activeAccount", (d) => { if (d && d.activeAccount) webLogin(tabId, d.activeAccount); });
    } else if (msg.action === "closeTab") {
      chrome.tabs.remove(tabId);
    }
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { unfreezeTab(tabId).catch(() => {}); });

/* ─────────────── SMSPool balance: badge + 1-minute refresh ─────────────── */

function setBadge(bal) {
  if (!chrome.action) return;
  let t = bal == null || bal === "" ? "" : String(bal);
  if (t.length > 4 && t.indexOf(".") !== -1) t = t.split(".")[0]; // keep it short on the icon
  try { chrome.action.setBadgeText && chrome.action.setBadgeText({ text: t }); } catch (e) {}
  try { chrome.action.setBadgeBackgroundColor && chrome.action.setBadgeBackgroundColor({ color: "#8600ff" }); } catch (e) {}
  try { chrome.action.setTitle && chrome.action.setTitle({ title: bal != null && bal !== "" ? `SMSPool balance: $${bal}` : "Deliveroo tools" }); } catch (e) {}
}

async function fetchBalance(key) {
  const fd = new FormData();
  fd.append("key", key);
  const r = await fetch(SMSPOOL + "/request/balance", { method: "POST", body: fd });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (r.status === 200 && data && Object.prototype.hasOwnProperty.call(data, "balance")) {
    return data.balance === "" || data.balance == null ? null : data.balance;
  }
  throw new Error("balance check failed (" + r.status + ")");
}

// Refresh the stored balance + badge if we have a verified key. Returns the balance.
async function refreshBalance() {
  const d = await chrome.storage.local.get(["smspoolKey", "smspoolValid"]);
  if (!d.smspoolKey || !d.smspoolValid) { setBadge(""); return null; }
  try {
    const bal = await fetchBalance(d.smspoolKey);
    await chrome.storage.local.set({ smspoolBalance: bal });
    setBadge(bal);
    return bal;
  } catch (_) {
    return null; // keep last-known balance/badge on a transient failure
  }
}

function ensureBalanceAlarm() {
  if (CAP.alarms) chrome.alarms.create("smspoolBalance", { periodInMinutes: 1 });
}

if (CAP.alarms) chrome.alarms.onAlarm.addListener((a) => { if (a.name === "smspoolBalance") refreshBalance(); });
chrome.runtime.onInstalled.addListener(() => { ensureBalanceAlarm(); refreshBalance(); });
chrome.runtime.onStartup.addListener(() => { ensureBalanceAlarm(); refreshBalance(); });
ensureBalanceAlarm(); // also when the worker first spins up

// React to popup edits: re-check when a key is verified; clear the badge if invalidated.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.smspoolValid) {
    if (ch.smspoolValid.newValue) refreshBalance();
    else setBadge("");
  } else if (ch.smspoolBalance && ch.smspoolBalance.newValue != null) {
    setBadge(ch.smspoolBalance.newValue);
  }
});

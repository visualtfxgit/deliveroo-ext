// background.js — Clear data + freeze + glassmorphic overlay, and the
// "Make a new Deliveroo account" flow (Manual = go to login, Auto = server-proxied
// SMSPool OTP → Bearer token → best-effort web login).
//
// Header spoofing on api.uk.deliveroo.com is declarative (rules.json).

// Gate: the extension is inert until it's linked to a NexaServe account (a website
// extension-link token). Paid enforcement is authoritative on the proxy server (every
// /proxy + /otp call is gated on the account being a paid subscriber); locally we treat
// "has a link token" as active — a linked-but-unpaid user's calls just get denied server-side.
async function isLicensed() {
  const d = await chrome.storage.local.get("extToken");
  return !!(d && d.extToken);
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

// ── Account-creation service (server-side) ───────────────────────────────────
// The whole Deliveroo signup — rent number, verify SMS, register, apply voucher — runs on our
// licence-gated proxy server (POST /create, streamed back as SSE), through a residential GB IP.
// None of that methodology, nor any credentials, lives in this (public) extension. The only
// account step that stays here is the final web-login, which must run in the user's own browser.
const PROXY_SERVERS = [
  "https://roo-proxy.nexaserve.uk",                     // primary — custom domain
  "https://roo-proxy-server-production.up.railway.app", // fallback — Railway default domain
];

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

/* ───────── key-activation sequence ─────────
   On a FRESH activation: freeze the tab (block everything except our nexaserve/linking hosts) +
   show "Activating…", hold 5s, wipe Deliveroo cookies/site-data, then reload the tab. A flag tells
   the reloaded content script to show the success UI. */
const ACT_ALLOW_RULE_BASE = 71000; // allow-rule id per tab during the freeze
const ACTIVATION_KEEP_HOSTS = ["deliveroo.nexaserve.uk", "roo-ext-production.up.railway.app"];
let _activatingTabs = new Set();
function freezeForActivation(tabId) {
  if (!CAP.dnrSession) return Promise.resolve();
  const allowId = ACT_ALLOW_RULE_BASE + (tabId % 1000);
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId, allowId],
    addRules: [
      { id: tabId, priority: 100, action: { type: "block" }, condition: { tabIds: [tabId], resourceTypes: BLOCK_RESOURCE_TYPES } },
      // higher priority allow → our licensing/IP/device hosts still go through (needed to link)
      { id: allowId, priority: 101, action: { type: "allow" }, condition: { tabIds: [tabId], requestDomains: ACTIVATION_KEEP_HOSTS, resourceTypes: BLOCK_RESOURCE_TYPES } },
    ],
  }).catch(() => {});
}
function clearActivationFreeze(tabId) {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId, ACT_ALLOW_RULE_BASE + (tabId % 1000)], addRules: [] }).catch(() => {});
}
async function startActivationSequence(tabId) {
  if (_activatingTabs.has(tabId)) return;
  _activatingTabs.add(tabId);
  try {
    await chrome.storage.local.set({ __activating: Date.now() }); // popup shows "Activating…" too
    await freezeForActivation(tabId);
    chrome.tabs.sendMessage(tabId, { type: "rooActivating" }, () => void chrome.runtime.lastError);
    await new Promise((r) => setTimeout(r, 5000));     // the visible "Activating…" beat
    await clearAll(tabId).catch(() => {});             // wipe Deliveroo cookies + 3rd-party site data
    await chrome.storage.local.set({ __activationSuccess: Date.now() }); // reloaded page → success UI (time-bound)
    await chrome.storage.local.remove("__activating");
    await clearActivationFreeze(tabId);
    chrome.tabs.reload(tabId, { bypassCache: true }, () => void chrome.runtime.lastError);
  } finally { _activatingTabs.delete(tabId); try { await chrome.storage.local.remove("__activating"); } catch (e) {} }
}
// Pick the tab to run the activation on (active Deliveroo tab, else any open Deliveroo tab).
function runActivationOnDeliverooTab() {
  const isRoo = (u) => /^https:\/\/([a-z0-9-]+\.)?deliveroo\.(co\.uk|com)\//i.test(u || "");
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const t = (tabs || [])[0];
    if (t && t.id != null && isRoo(t.url)) return startActivationSequence(t.id);
    chrome.tabs.query({}, (all) => { const d = (all || []).find((x) => x.id != null && isRoo(x.url)); if (d) startActivationSequence(d.id); });
  });
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
function removeHeaderRules() {
  if (!CAP.dnrSession) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: HEADER_RULE_IDS, addRules: [] }).catch(() => {});
}

/* ───────── dynamic gate ─────────
   The whole extension stays INERT (no header spoofing) until it's linked to a NexaServe account.
   "Linked" = a website extension-link token is present (grabbed on the dashboard or pasted).
   Paid/subscription enforcement is authoritative on the proxy server, checked live on every
   /proxy + /otp call — so we don't re-check it here; we just reflect "linked" into the DNR rules +
   the on-page banner. Re-evaluated on startup, on the alarm, and whenever the token changes. */
let _licOk = false;
async function evalLicense() {
  return await isLicensed(); // linked ⇢ active; server enforces paid on each call
}
async function applyLicenseState() {
  let ok = false;
  try { ok = await evalLicense(); } catch (e) { ok = false; }
  _licOk = ok;
  try { await chrome.storage.local.set({ __licOk: ok }); } catch (e) {}
  if (ok) await ensureHeaderRules(); else await removeHeaderRules();
  broadcastLicensed(ok);
  return ok;
}
function broadcastLicensed(ok) {
  // Query ALL tabs (only needs tab.id → no "tabs" permission); non-Deliveroo tabs have no listener
  // and ignore it. Lets an already-open page flip on/off live (link / unlink) without a reload.
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) return;
      (tabs || []).forEach((t) => { if (t && t.id != null) try { chrome.tabs.sendMessage(t.id, { type: "rooLicenseState", licensed: ok }, () => void chrome.runtime.lastError); } catch (e) {} });
    });
  } catch (e) {}
}
applyLicenseState();
chrome.runtime.onInstalled.addListener(() => applyLicenseState());
chrome.runtime.onStartup.addListener(() => applyLicenseState());
if (CAP.alarms) chrome.alarms.create("licenseCheck", { periodInMinutes: 2 });
if (CAP.alarms) chrome.alarms.onAlarm.addListener((a) => { if (a.name === "licenseCheck") applyLicenseState(); });

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

const EXT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return ""; } })();

// When the server tells us the account isn't paid (or the link is gone), reflect it locally right
// away so the banner/popup flip to "no subscription" without waiting for a dashboard revisit. The
// server stays the authoritative gate — this is only UI freshness.
function noteAccess(reason) {
  if (reason === "not_subscribed" || reason === "unlinked") {
    try { chrome.storage.local.set({ extPaid: false }); } catch (e) {}
  }
}

// Kick off a full server-side account creation and stream its SSE progress to the page overlay.
// The whole Deliveroo signup runs on the proxy server (through the residential IP); we only relay
// the step events to the UI and return the finished account. Returns null once an error was shown.
async function createViaServer(tabId) {
  const st = await chrome.storage.local.get("extToken");
  const token = (st && st.extToken) || "";
  let res = null, lastErr = "unreachable";
  for (const base of PROXY_SERVERS) {
    try {
      const r = await fetch(base + "/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (r && r.ok && r.body) { res = r; break; }
      lastErr = "http_" + (r ? r.status : "0");
    } catch (e) { lastErr = String((e && e.message) || e); }
  }
  if (!res) {
    chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "error", message: "Couldn't reach the creation service (" + lastErr + ")." }).catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const NL = String.fromCharCode(10);
  let buf = "", account = null, errored = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf(NL + NL)) >= 0) {
      const line = buf.slice(0, i).split(NL).find((l) => l.startsWith("data:"));
      buf = buf.slice(i + 2);
      if (!line) continue;
      let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (evt.kind === "step") sendStep(tabId, evt.key, evt.text, evt.state);
      else if (evt.kind === "error") { errored = true; noteAccess(evt.reason); chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "error", title: evt.title, message: evt.message }).catch(() => {}); }
      else if (evt.kind === "done") account = evt.account;
    }
  }
  return errored ? null : account;
}

/* ─────────────────── auto account creation pipeline ─────────────────── */

function sendStep(tabId, key, text, state) {
  chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "step", key, text, state }).catch(() => {});
}

async function autoCreate(tabId) {
  if (!(await isLicensed())) {
    chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "error", message: "Link your NexaServe account first — sign in at dashboard.nexaserve.uk (or paste your link token in the popup)." }).catch(() => {});
    return;
  }

  // The whole Deliveroo signup (rent, verify, register, voucher) runs on the server and streams
  // its progress into the overlay; we get back the finished account (or null after an error step).
  const account = await createViaServer(tabId);
  if (!account) return;

  // The one account step that must run in the browser: log the tab into deliveroo.co.uk with the
  // new credentials, so the session binds to the user's OWN browser/IP (a server-side login would
  // bind it to the residential proxy and Deliveroo could drop it once the user browses normally).
  sendStep(tabId, "weblogin", "Logging into the website…", "run");
  try {
    const cat = CAP.dnrSession
      ? await webApiLogin(account.email, account.password)
      : await webApiLoginPage(tabId, account.email, account.password);
    account.consumerAuthToken = cat;
    account.webLoginOk = true;
    await setAuthHeader(cat).catch(() => {}); // the bearer to keep is the consumer_auth_token cookie
    sendStep(tabId, "weblogin", "Logged in — session cookies applied", "ok");
  } catch (e) {
    account.webLoginOk = false;
    sendStep(tabId, "weblogin", "Web login failed: " + String((e && e.message) || e), "fail");
  }

  await chrome.storage.local.set({ activeAccount: account });
  chrome.tabs.sendMessage(tabId, { __rooAuto: true, kind: "done", account }).catch(() => {});
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

  if (msg.type === "extLink") { // sitelink.js grabbed the website link token + live paid status
    (async () => {
      try {
        const patch = { extToken: msg.token, extAt: Date.now() };
        if (typeof msg.paid === "boolean") patch.extPaid = msg.paid;
        if (typeof msg.plan === "string") patch.extPlan = msg.plan;
        await chrome.storage.local.set(patch);
      } catch (e) {}
    })();
    return;
  }

  if (msg.type === "rooKeyActivated") { // popup unlocked a key (any key) → run the activation sequence
    applyLicenseState(); runActivationOnDeliverooTab();
    return;
  }

  if (msg.type === "rooLicenseConfig") { // page asks whether the extension is linked (active)
    (async () => {
      const st = await chrome.storage.local.get("__licOk");
      sendResponse({ licensed: !!(st && st.__licOk), outdated: false, required: "", current: EXT_VERSION });
    })();
    applyLicenseState(); // also kick a fresh check (broadcasts if it changed)
    return true; // async
  }

  if (msg.type === "reinitDnr") { applyLicenseState(); return; } // DNR just granted on Chrome → re-apply gated state

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

// React to link changes: the site content script or the popup paste box writing extToken/extPaid
// flips the gate (linked → active, unlinked → inert) live, without a reload.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.extToken || ch.extPaid) applyLicenseState();
});

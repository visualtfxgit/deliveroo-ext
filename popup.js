// popup.js — account link status + "Clear data" + a current-IP display with a reset guide.
//
// The extension is gated on the user's NexaServe website subscription, not a standalone key.
// Linking happens automatically when signed in at dashboard.nexaserve.uk (a content script grabs
// a link token); this popup also accepts the token by paste, shows link/paid status, clears the
// Deliveroo session, and helps switch to a fresh IP before a signup.

const lockScreen = document.getElementById("lockScreen");
const mainScreen = document.getElementById("mainScreen");
const linkTokenEl = document.getElementById("linkToken");
const linkBtn = document.getElementById("unlock");
const lockStatus = document.getElementById("lockStatus");
const licInfo = document.getElementById("licInfo");
const signOutBtn = document.getElementById("signOut");

let mainInited = false;

function setLockStatus(text, cls) { lockStatus.textContent = text; lockStatus.className = cls || "muted"; }

function showLock(msg, cls) {
  mainScreen.classList.add("hidden");
  lockScreen.classList.remove("hidden");
  const rv = document.getElementById("ipResetView"); if (rv) rv.classList.add("hidden");
  setLockStatus(msg || "", cls);
  try { linkTokenEl.focus(); } catch (e) {}
}

function fmtLink(paid, plan) {
  if (paid === false) return "Linked · no active subscription";
  if (plan && plan !== "None") return "Linked · " + plan;
  return "Linked";
}

function showMain(paid, plan) {
  lockScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  licInfo.textContent = fmtLink(paid, plan);
  licInfo.style.color = paid === false ? "var(--err)" : "";
  if (!mainInited) { mainInited = true; initMain(); }
}

// Route to the right screen from stored link state.
function render() {
  chrome.storage.local.get(["extToken", "extPaid", "extPlan"], (d) => {
    if (d && d.extToken) showMain(d.extPaid, d.extPlan);
    else showLock("");
  });
}
render();

// Live-update if the site content script links/unlinks while the popup is open.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.extToken || ch.extPaid || ch.extPlan) render();
});

// Paste-link fallback: store the token → background flips the gate via storage.onChanged.
async function doLink() {
  const token = (linkTokenEl.value || "").trim();
  if (!token) { setLockStatus("Paste your link token first.", "err"); return; }
  linkBtn.disabled = true;
  setLockStatus("Linking…", "muted");
  try {
    await chrome.storage.local.set({ extToken: token, extAt: Date.now() });
    await chrome.storage.local.remove("extPaid"); // let the server re-check paid status on next use
    setLockStatus("✓ Linked", "ok");
    render();
  } catch (e) {
    setLockStatus("Couldn't save the token.", "err");
  } finally {
    linkBtn.disabled = false;
  }
}
linkBtn.addEventListener("click", doLink);
linkTokenEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doLink(); });

// Unlink: forget the token on this browser (re-link by signing in on the dashboard again).
signOutBtn.addEventListener("click", async () => {
  signOutBtn.disabled = true;
  try { await chrome.storage.local.remove(["extToken", "extPaid", "extPlan", "extAt"]); } catch (e) {}
  signOutBtn.disabled = false;
  linkTokenEl.value = "";
  showLock("Unlinked from this browser.", "muted");
});

/* ───────────────────── main UI (wired only once linked) ───────────────────── */

function initMain() {
  const clearBtn = document.getElementById("clear");
  const resultEl = document.getElementById("result");
  function setResult(text, cls) { resultEl.textContent = text; resultEl.className = cls || "muted"; }

  /* ── Your IP + Reset IP guide (public IP lookup; no server needed) ── */
  const ipValue = document.getElementById("ipValue");
  const ipStatus = document.getElementById("ipStatus");
  const resetIpBtn = document.getElementById("resetIp");
  const ipResetView = document.getElementById("ipResetView");
  const ipResetCurrent = document.getElementById("ipResetCurrent");
  const ipResetCancel = document.getElementById("ipResetCancel");

  let currentIp = null, pollTimer = 0;

  async function getIp() {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    return d && d.ip ? String(d.ip) : null;
  }
  async function refreshIp() {
    ipValue.textContent = "checking…";
    try {
      currentIp = await getIp();
      ipValue.textContent = currentIp || "unavailable";
    } catch (e) { ipValue.textContent = "unavailable"; }
  }

  function isDesktopUA() {
    try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") return !navigator.userAgentData.mobile; } catch (e) {}
    return !/Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  }
  function showResetView(fromIp) {
    ipResetCurrent.textContent = fromIp || currentIp || "…";
    const gd = document.getElementById("ipGuideDesktop"), gm = document.getElementById("ipGuideMobile");
    const desktop = isDesktopUA();
    if (gd) gd.classList.toggle("hidden", !desktop);
    if (gm) gm.classList.toggle("hidden", desktop);
    mainScreen.classList.add("hidden");
    ipResetView.classList.remove("hidden");
  }
  function hideResetView() { ipResetView.classList.add("hidden"); mainScreen.classList.remove("hidden"); }
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; } }

  async function startReset() {
    await chrome.storage.local.set({ ipResetFrom: currentIp || "" });
    showResetView(currentIp);
    pollReset();
  }
  // Poll until the IP differs from the one at reset time. Tolerates being offline (airplane mode).
  async function pollReset() {
    stopPoll();
    const s = await chrome.storage.local.get("ipResetFrom");
    if (s.ipResetFrom == null) { hideResetView(); return; }
    try {
      const ip = await getIp();
      if (ip && ip !== s.ipResetFrom) {
        await chrome.storage.local.remove("ipResetFrom");
        currentIp = ip;
        hideResetView();
        await refreshIp();
        return;
      }
    } catch (e) { /* offline — keep waiting */ }
    pollTimer = setTimeout(pollReset, 4000);
  }

  resetIpBtn.addEventListener("click", startReset);
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

  /* ── Clear data ── */
  clearBtn.addEventListener("click", () => {
    clearBtn.disabled = true;
    setResult("Clearing…", "muted");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = (tabs && tabs[0]) || {};
      chrome.runtime.sendMessage({ type: "clearData", tabId: tab.id, tabUrl: tab.url }, (res) => {
        clearBtn.disabled = false;
        if (chrome.runtime.lastError) { setResult("Failed: " + chrome.runtime.lastError.message, "err"); return; }
        if (!res || !res.ok) {
          setResult(res && res.error === "locked" ? "Link your NexaServe account first." : "Failed: " + ((res && res.error) || "unknown error"), "err");
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
  }, { once: false });
}

// content.js — declared content script on deliveroo.co.uk / deliveroo.com.
// Replaces chrome.scripting.executeScript (the `scripting` permission, which Orion
// rejects). The background messages this script to render the post-clear overlay, run the
// page-context web login, or wipe page storage. Passive until messaged.
(function () {
  "use strict";
  if (window.__rooContentLoaded) return;
  window.__rooContentLoaded = true;

  var LOGO = chrome.runtime.getURL("logo.png");
  var rc = { setStep: null, screenResult: null, screenError: null }; // hooks into the live overlay

  /* ───────────────────────── overlay ───────────────────────── */
  function buildOverlay() {
    if (document.getElementById("__roo-clear-overlay")) return;
    var root = document.documentElement || document.body;
    if (!root) return;

    var CSS = [
      "#__roo-clear-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;",
      "  background:rgba(22,2,42,0.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);",
      "  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;animation:__rc_fade .25s ease both;}",
      "@keyframes __rc_fade{from{opacity:0}to{opacity:1}}",
      "#__roo-clear-card{width:min(440px,92vw);max-height:88vh;overflow:auto;scrollbar-width:none;-ms-overflow-style:none;padding:30px 28px 22px;border-radius:20px;",
      "  background:rgba(134,0,255,0.16);border:1px solid rgba(180,120,255,0.38);",
      "  box-shadow:0 8px 40px rgba(40,0,80,0.55),0 0 0 1px rgba(134,0,255,0.10),inset 0 1px 0 rgba(255,255,255,0.25);",
      "  backdrop-filter:blur(22px) saturate(160%);-webkit-backdrop-filter:blur(22px) saturate(160%);",
      "  position:relative;color:#fff;text-align:center;animation:__rc_pop .28s cubic-bezier(.2,.9,.3,1.2) both;}",
      "#__roo-clear-card::-webkit-scrollbar{width:0;height:0;display:none;}",
      "@keyframes __rc_pop{from{transform:translateY(12px) scale(.96);opacity:0}to{transform:none;opacity:1}}",
      "@property --rc-ang{syntax:'<angle>';inherits:false;initial-value:0deg;}",
      "#__roo-clear-card::before{content:'';position:absolute;inset:-2px;border-radius:22px;padding:2px;",
      "  background:conic-gradient(from var(--rc-ang),rgba(134,0,255,0) 0deg,rgba(134,0,255,0) 200deg,#c08cff 285deg,#ffffff 322deg,#c08cff 350deg,rgba(134,0,255,0) 360deg);",
      "  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;",
      "  filter:drop-shadow(0 0 6px rgba(170,90,255,0.9));pointer-events:none;animation:__rc_neon 3.4s linear infinite;}",
      "@keyframes __rc_neon{to{--rc-ang:360deg}}",
      "#__roo-clear-card .__rc-logo{display:block;margin:0 auto 14px;height:96px;width:auto;object-fit:contain;filter:drop-shadow(0 2px 10px rgba(40,0,80,0.5));}",
      "#__roo-clear-card h2{margin:0 0 6px;font-size:18px;font-weight:600;}",
      "#__roo-clear-card p.sub{margin:0 0 4px;font-size:12.5px;opacity:.82;line-height:1.5;}",
      ".__rc-btnrow{display:flex;flex-direction:column;gap:10px;margin-top:20px;}",
      ".__rc-btn{width:100%;padding:13px 14px;border-radius:12px;cursor:pointer;font-size:14px;font-weight:600;",
      "  border:1px solid rgba(255,255,255,0.28);color:#fff;transition:transform .08s ease,background .15s ease;}",
      ".__rc-btn:active{transform:scale(.98);}.__rc-btn:disabled{opacity:.5;cursor:default;}",
      ".__rc-primary{background:rgba(134,0,255,0.88);border-color:rgba(180,120,255,0.6);}.__rc-primary:hover{background:rgba(150,40,255,1);}",
      ".__rc-ghost{background:rgba(255,255,255,0.14);}.__rc-ghost:hover{background:rgba(255,255,255,0.26);}",
      ".__rc-back{background:transparent;border:none;color:#e7d6ff;opacity:.8;font-size:12.5px;margin-top:6px;cursor:pointer;}",
      ".__rc-steps{list-style:none;margin:18px 0 0;padding:0;text-align:left;}",
      ".__rc-steps li{display:flex;align-items:center;gap:10px;padding:7px 2px;font-size:13px;opacity:.92;}",
      ".__rc-ico{width:18px;height:18px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;}",
      ".__rc-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,0.35);border-top-color:#fff;border-radius:50%;animation:__rc_sp .7s linear infinite;}",
      "@keyframes __rc_sp{to{transform:rotate(360deg)}}",
      ".__rc-ok{color:#54e39b;font-weight:700;}.__rc-fail{color:#ff8a8a;font-weight:700;}",
      ".__rc-field{text-align:left;margin-top:10px;}",
      ".__rc-field label{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin:0 0 3px;}",
      ".__rc-codewrap{position:relative;}",
      ".__rc-code{display:block;width:100%;box-sizing:border-box;padding:10px 40px 10px 12px;border-radius:10px;",
      "  background:rgba(26,0,50,0.34);border:1px solid rgba(180,120,255,0.28);color:#fff;",
      "  font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:12.5px;word-break:break-all;user-select:all;}",
      ".__rc-copy{position:absolute;top:6px;right:6px;width:26px;height:26px;border-radius:7px;cursor:pointer;border:1px solid rgba(255,255,255,0.22);",
      "  background:rgba(255,255,255,0.14);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;}",
      ".__rc-copy:hover{background:rgba(255,255,255,0.26);}.__rc-copy.done{background:rgba(72,200,120,0.9);}",
      "#__roo-clear-card .__rc-footer{margin:16px 0 0;text-align:center;font-size:10px;font-weight:600;letter-spacing:1.5px;opacity:.55;text-transform:uppercase;}",
      "#__roo-clear-card .__rc-err{margin-top:14px;color:#ff9b9b;font-size:12.5px;font-weight:600;line-height:1.5;}",
    ].join("");

    var style = document.createElement("style");
    style.textContent = CSS;
    var overlay = document.createElement("div");
    overlay.id = "__roo-clear-overlay";
    var card = document.createElement("div");
    card.id = "__roo-clear-card";
    overlay.appendChild(card);

    function send(action) { try { chrome.runtime.sendMessage({ __rooClear: true, action: action }); } catch (e) {} }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function logo() { var i = el("img", "__rc-logo"); i.alt = "NexaServe"; i.src = LOGO; return i; }
    function footer() { return el("div", "__rc-footer", "Made by TFX"); }
    function clear() { card.textContent = ""; }

    function screenMain() {
      clear();
      card.appendChild(logo());
      card.appendChild(el("h2", null, "Deliveroo data cleared"));
      card.appendChild(el("p", "sub", "All Deliveroo cookies & site data on this device have been wiped. What next?"));
      var row = el("div", "__rc-btnrow");
      var mk = el("button", "__rc-btn __rc-primary", "Make a new Deliveroo account");
      var cl = el("button", "__rc-btn __rc-ghost", "Close tab");
      mk.onclick = screenChoice;
      cl.onclick = function () { send("closeTab"); };
      row.appendChild(mk); row.appendChild(cl);
      card.appendChild(row);
      card.appendChild(footer());
    }

    function screenChoice() {
      clear();
      card.appendChild(logo());
      card.appendChild(el("h2", null, "New Deliveroo account"));
      card.appendChild(el("p", "sub", "Create it automatically (rents a number via SMSPool and grabs the bearer token), or do it yourself on the login page."));
      var row = el("div", "__rc-btnrow");
      var auto = el("button", "__rc-btn __rc-primary", "Auto — create it for me");
      var man = el("button", "__rc-btn __rc-ghost", "Manual — go to login");
      auto.disabled = true;
      auto.onclick = function () { if (auto.disabled) return; send("autoCreate"); screenAuto(); };
      man.onclick = function () { send("newAccountManual"); };
      row.appendChild(auto); row.appendChild(man);
      card.appendChild(row);
      var hint = el("p", "sub", "Checking SMSPool key…");
      hint.style.marginTop = "10px"; hint.style.fontSize = "11.5px";
      card.appendChild(hint);
      try {
        chrome.storage.local.get(["smspoolValid", "smspoolBalance"], function (d) {
          if (d && d.smspoolValid) {
            auto.disabled = false;
            hint.textContent = (d.smspoolBalance != null && d.smspoolBalance !== "")
              ? ("SMSPool ready · balance $" + d.smspoolBalance) : "SMSPool key verified.";
          } else {
            auto.disabled = true;
            hint.textContent = "Auto needs a valid SMSPool key — set & submit it in the extension popup.";
          }
        });
      } catch (e) { auto.disabled = true; hint.textContent = "Auto needs a valid SMSPool key (set it in the popup)."; }
      var back = el("button", "__rc-back", "← Back");
      back.onclick = screenMain;
      card.appendChild(back);
      card.appendChild(footer());
    }

    var steps;
    function screenAuto() {
      clear();
      card.appendChild(logo());
      card.appendChild(el("h2", null, "Creating your account…"));
      card.appendChild(el("p", "sub", "Sit tight — this can take a minute while the SMS arrives."));
      steps = el("ul", "__rc-steps");
      card.appendChild(steps);
      card.appendChild(footer());
    }
    function setStep(key, text, state) {
      if (!steps) return;
      var li = steps.querySelector('li[data-k="' + key + '"]');
      if (!li) { li = el("li"); li.setAttribute("data-k", key); var ic = el("span", "__rc-ico"); var tx = el("span", "__rc-tx"); li.appendChild(ic); li.appendChild(tx); steps.appendChild(li); }
      li.querySelector(".__rc-tx").textContent = text;
      var ico = li.querySelector(".__rc-ico");
      ico.textContent = ""; ico.className = "__rc-ico";
      if (state === "run") { var s = el("span", "__rc-spin"); ico.appendChild(s); }
      else if (state === "ok") { ico.className = "__rc-ico __rc-ok"; ico.textContent = "✓"; }
      else if (state === "fail") { ico.className = "__rc-ico __rc-fail"; ico.textContent = "✕"; }
    }

    function field(labelTxt, value) {
      var wrap = el("div", "__rc-field");
      wrap.appendChild(el("label", null, labelTxt));
      var cw = el("div", "__rc-codewrap");
      var code = el("code", "__rc-code", value);
      var btn = el("button", "__rc-copy", "⧉");
      btn.title = "Copy";
      btn.onclick = function () {
        try { navigator.clipboard.writeText(value); } catch (e) {}
        btn.classList.add("done"); btn.textContent = "✓";
        setTimeout(function () { btn.classList.remove("done"); btn.textContent = "⧉"; }, 1400);
      };
      cw.appendChild(code); cw.appendChild(btn); wrap.appendChild(cw);
      return wrap;
    }
    function screenResult(acc) {
      clear();
      card.appendChild(logo());
      card.appendChild(el("h2", null, "Account ready ✓"));
      card.appendChild(el("p", "sub", acc.webLoginOk
        ? "Account created and logged into the website — session cookies applied. Open Deliveroo to land logged-in."
        : "Account created. Web login didn't complete — use the credentials below to sign in."));
      card.appendChild(field("Email", acc.email));
      card.appendChild(field("Password", acc.password));
      card.appendChild(field("Phone", acc.phone));
      if (acc.userId) card.appendChild(field("User ID", String(acc.userId)));
      if (acc.voucher) card.appendChild(field("Voucher applied", acc.voucher));
      var row = el("div", "__rc-btnrow");
      var go = el("button", "__rc-btn __rc-primary", acc.webLoginOk ? "Open Deliveroo (logged in) →" : "Go to login");
      var cl = el("button", "__rc-btn __rc-ghost", "Close tab");
      go.onclick = function () { go.disabled = true; go.textContent = "Opening login…"; send("webLogin"); };
      cl.onclick = function () { send("closeTab"); };
      row.appendChild(go); row.appendChild(cl);
      card.appendChild(row);
      card.appendChild(footer());
    }
    function screenError(msg, title) {
      if (!steps) screenAuto();
      var existing = card.querySelector(".__rc-err");
      if (existing) existing.remove();
      card.querySelector("h2").textContent = title || "Couldn't finish";
      var e = el("p", "__rc-err", msg);
      card.insertBefore(e, card.querySelector(".__rc-footer"));
      var row = el("div", "__rc-btnrow");
      var retry = el("button", "__rc-btn __rc-primary", "Try again");
      var cl = el("button", "__rc-btn __rc-ghost", "Close tab");
      retry.onclick = function () { send("autoCreate"); screenAuto(); };
      cl.onclick = function () { send("closeTab"); };
      row.appendChild(retry); row.appendChild(cl);
      card.insertBefore(row, card.querySelector(".__rc-footer"));
    }

    rc.setStep = setStep; rc.screenResult = screenResult; rc.screenError = screenError;

    root.appendChild(style);
    root.appendChild(overlay);
    screenMain();
  }

  /* ───────────────────── page-context web login ───────────────────── */
  function pageLogin(email, password) {
    return (async function () {
      function ck(n) { return (document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)")) || [])[1] || ""; }
      try {
        if (!ck("roo_guid")) {
          await fetch("/login?redirect=%2F", { credentials: "include" });
        }
        const rooGuid = decodeURIComponent(ck("roo_guid"));
        const rooSession = decodeURIComponent(ck("roo_session_guid"));
        const H = {
          "accept": "application/json, application/vnd.api+json",
          "content-type": "application/json",
          "x-roo-platform": "iOS",
          "x-roo-country": "uk",
          "x-roo-guid": rooGuid,
          "x-roo-sticky-guid": rooGuid,
          "x-roo-session-guid": rooSession,
          "x-roo-client-referer": "",
          "x-roo-external-device-id": "",
        };
        const pr = await fetch("/api/auth/props?redirect=%2F", { credentials: "include", headers: H });
        if (!pr.ok) return { ok: false, step: "props", status: pr.status };
        const props = await pr.json();
        const csrf = props.csrf_token;
        if (!csrf) return { ok: false, step: "csrf" };
        const lr = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "include",
          headers: Object.assign({}, H, { "x-csrf-token": csrf, "x_roo_challenge_support": "passcode" }),
          body: JSON.stringify({ email, password, page_in_progress: "login" }),
        });
        return { ok: lr.ok, status: lr.status, token: ck("consumer_auth_token") || null };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  /* ───────────────────── storage wipe fallback ───────────────────── */
  function storageWipe() {
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
    try { if (indexedDB && indexedDB.databases) indexedDB.databases().then(function (dbs) { (dbs || []).forEach(function (d) { if (d && d.name) indexedDB.deleteDatabase(d.name); }); }); } catch (e) {}
    try { if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) navigator.serviceWorker.getRegistrations().then(function (rs) { (rs || []).forEach(function (r) { r.unregister(); }); }); } catch (e) {}
    try { if (window.caches && caches.keys) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }); } catch (e) {}
  }

  /* ───────────────────────── dispatcher ───────────────────────── */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === "showOverlay") { buildOverlay(); return; }
    if (msg.type === "storageWipe") { storageWipe(); return; }
    if (msg.type === "pageLogin") { pageLogin(msg.email, msg.password).then(sendResponse); return true; }
    if (msg.__rooAuto) {
      if (msg.kind === "step" && rc.setStep) rc.setStep(msg.key, msg.text, msg.state);
      else if (msg.kind === "done" && rc.screenResult) rc.screenResult(msg.account);
      else if (msg.kind === "error" && rc.screenError) rc.screenError(msg.message, msg.title);
      return;
    }
  });
})();

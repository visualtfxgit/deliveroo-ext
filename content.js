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
  function buildOverlay(initial) {
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
      ".__rc-close{position:absolute;top:12px;right:12px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.1);color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;}",
      ".__rc-close:hover{background:rgba(255,255,255,0.24);}",
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

    function closeOverlay() { var ov = document.getElementById("__roo-clear-overlay"); if (ov) ov.remove(); }
    function closeX() { var x = el("button", "__rc-close", "✕"); x.title = "Close"; x.onclick = closeOverlay; return x; }

    // The banner opens HERE — the full menu, not the post-clear result screen.
    function screenHome() {
      clear();
      card.appendChild(closeX());
      card.appendChild(logo());
      card.appendChild(el("h2", null, "Deliveroo Reset"));
      card.appendChild(el("p", "sub", "Wipe your Deliveroo session and spin up a fresh account."));
      var row = el("div", "__rc-btnrow");
      var clr = el("button", "__rc-btn __rc-primary", "Clear Deliveroo data");
      var acc = el("button", "__rc-btn __rc-ghost", "Make a new account");
      clr.onclick = function () { clr.disabled = true; clr.textContent = "Clearing…"; try { chrome.runtime.sendMessage({ type: "clearData" }, function () { void chrome.runtime.lastError; screenMain(); }); } catch (e) { screenMain(); } };
      acc.onclick = screenChoice;
      row.appendChild(clr); row.appendChild(acc);
      card.appendChild(row);
      card.appendChild(footer());
    }

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
    if (initial === "home") screenHome(); else screenMain();
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
    if (msg.type === "rooActivating") { rooShowActivating(); return; } // key just redeemed → activation overlay
    if (msg.type === "rooLicenseState") { rooSetLicensed(!!msg.licensed); return; } // live licence on/off (redeem / expiry) → banner
  });

  // Pull the licence/version state and update the banner + "update required" overlay. Re-asks on
  // each page load, so a fresh redeem/expiry/version bump applies without waiting for the alarm.
  try {
    chrome.runtime.sendMessage({ type: "rooLicenseConfig" }, function (res) {
      var err = chrome.runtime.lastError;
      var licensed = (!err && res && typeof res.licensed === "boolean") ? res.licensed : false;
      var outdated = !err && res && res.outdated === true;
      if (outdated) { rooShowUpdate(res.required, res.current); } else { rooHideUpdate(); }
      rooSetLicensed(licensed); // show/hide the always-on banner (licensed is false when outdated)
    });
  } catch (e) {}

  /* ═══════════════ activation flow + always-on banner UI (EXTREME) ═══════════════ */
  var _ui = { host: null, shadow: null, scrim: null, banner: null, licensed: false };
  function rooCss() {
    return [
      ":host,*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}",
      ":host{--violet:#8600ff;--violet-br:#b478ff;--card:rgba(26,9,50,.94);--text:#f3edff;--muted:#b9a8dd;--line:rgba(180,120,255,.22);--ok:#5fe0a0;}",
      ".rs-scrim{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(9,2,22,.62);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);animation:rs-fade .25s ease both;}",
      ".rs-hidden{display:none!important;}",
      "@keyframes rs-fade{from{opacity:0;}to{opacity:1;}}",
      ".rs-card{width:344px;max-width:88vw;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:32px 28px;text-align:center;color:var(--text);box-shadow:0 26px 90px rgba(0,0,0,.55),0 0 0 1px rgba(180,120,255,.07),0 0 50px rgba(134,0,255,.18);animation:rs-rise .35s cubic-bezier(.2,1,.3,1) both;}",
      "@keyframes rs-rise{from{transform:translateY(14px) scale(.97);opacity:0;}to{transform:translateY(0) scale(1);opacity:1;}}",
      ".rs-card h2{margin:16px 0 8px;font-size:21px;font-weight:700;letter-spacing:-.2px;}",
      ".rs-card p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.55;}",
      ".rs-spin{width:56px;height:56px;margin:2px auto 4px;border-radius:50%;border:4px solid rgba(180,120,255,.16);border-top-color:var(--violet-br);border-right-color:var(--violet-br);animation:rs-rot .8s linear infinite;}",
      "@keyframes rs-rot{to{transform:rotate(360deg);}}",
      ".rs-steps{text-align:left;margin:18px 0 6px;}",
      ".rs-step{display:flex;align-items:flex-start;gap:10px;font-size:12.5px;color:var(--muted);margin:9px 0;line-height:1.45;}",
      ".rs-step span{flex:0 0 auto;width:20px;height:20px;margin-top:1px;border-radius:50%;background:rgba(134,0,255,.32);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;}",
      ".rs-step b{color:var(--text);font-weight:600;}",
      ".rs-tick{width:90px;height:90px;margin:0 auto 8px;border-radius:50%;background:radial-gradient(circle at 50% 38%,rgba(134,0,255,.4),rgba(134,0,255,.06));display:flex;align-items:center;justify-content:center;animation:rs-pop .55s cubic-bezier(.18,1.6,.4,1) both;}",
      ".rs-tick svg{width:62px;height:62px;}",
      ".rs-tick circle{stroke:var(--violet-br);stroke-width:4;fill:none;stroke-dasharray:170;stroke-dashoffset:170;animation:rs-draw .55s ease .12s forwards;filter:drop-shadow(0 0 4px rgba(180,120,255,.7));}",
      ".rs-tick path{stroke:#fff;stroke-width:5.5;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:rs-draw .4s ease .5s forwards;}",
      "@keyframes rs-pop{from{transform:scale(.4);opacity:0;}to{transform:scale(1);opacity:1;}}",
      "@keyframes rs-draw{to{stroke-dashoffset:0;}}",
      ".rs-btn{margin-top:22px;width:100%;padding:13px;border:0;border-radius:13px;font-size:15px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--violet),var(--violet-br));box-shadow:0 8px 26px rgba(134,0,255,.42);transition:transform .12s,box-shadow .12s;}",
      ".rs-btn:hover{transform:translateY(-1px);box-shadow:0 12px 32px rgba(134,0,255,.55);}",
      ".rs-btn:active{transform:translateY(0);}",
      ".rs-panel{position:relative;width:290px;max-width:94vw;border-radius:20px;overflow:hidden;box-shadow:0 26px 90px rgba(0,0,0,.6),0 0 0 1px rgba(180,120,255,.1),0 0 50px rgba(134,0,255,.2);animation:rs-rise .35s cubic-bezier(.2,1,.3,1) both;}",
      ".rs-frame{display:block;width:290px;height:580px;max-height:86vh;border:0;background:#160a2e;}",
      ".rs-pclose{position:absolute;top:9px;right:9px;z-index:2;width:26px;height:26px;border-radius:50%;border:1px solid rgba(180,120,255,.3);background:rgba(20,5,40,.72);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:background .15s;}",
      ".rs-pclose:hover{background:rgba(50,14,86,.92);}",
      ".rs-bnr{position:fixed;top:14px;right:14px;z-index:2147483645;display:flex;align-items:center;gap:9px;padding:9px 15px 9px 11px;border-radius:999px;cursor:pointer;color:var(--text);background:linear-gradient(135deg,rgba(42,13,80,.96),rgba(26,8,52,.96));border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 18px rgba(134,0,255,.28);font-size:13px;font-weight:600;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);transition:transform .14s,box-shadow .14s;animation:rs-slide .4s ease both;}",
      ".rs-bnr:hover{transform:scale(1.04);box-shadow:0 14px 38px rgba(0,0,0,.5),0 0 26px rgba(134,0,255,.5);}",
      ".rs-bnr img{width:22px;height:22px;border-radius:6px;}",
      ".rs-bnr .rs-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 9px var(--ok);}",
      "@keyframes rs-slide{from{transform:translateY(-16px);opacity:0;}to{transform:translateY(0);opacity:1;}}",
    ].join("");
  }
  function rooEnsure() {
    if (_ui.host) return;
    _ui.host = document.createElement("div"); _ui.host.id = "roo-ext-ui"; _ui.host.style.cssText = "all:initial;position:static;";
    _ui.shadow = _ui.host.attachShadow({ mode: "open" });
    var st = document.createElement("style"); st.textContent = rooCss(); _ui.shadow.appendChild(st);
    _ui.scrim = document.createElement("div"); _ui.scrim.className = "rs-scrim rs-hidden"; _ui.shadow.appendChild(_ui.scrim);
    (document.documentElement || document.body).appendChild(_ui.host);
  }
  function rooEl(t, c, html) { var e = document.createElement(t); if (c) e.className = c; if (html != null) e.innerHTML = html; return e; }
  function rooLogo() { try { return (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("logo.png") : ""; } catch (e) { return ""; } }

  function rooShowActivating() {
    rooEnsure(); rooHideBanner();
    _ui.scrim.innerHTML = ""; _ui.scrim.onclick = null; // not dismissable by clicking out
    var card = rooEl("div", "rs-card");
    card.appendChild(rooEl("div", "rs-spin"));
    card.appendChild(rooEl("h2", null, "Activating key…"));
    card.appendChild(rooEl("p", null, "Linking your key and clearing this Deliveroo session. Hang tight — just a few seconds."));
    _ui.scrim.appendChild(card); _ui.scrim.classList.remove("rs-hidden");
  }
  function rooShowSuccess() {
    rooEnsure();
    _ui.scrim.innerHTML = ""; _ui.scrim.onclick = null;
    var card = rooEl("div", "rs-card");
    card.appendChild(rooEl("div", "rs-tick", '<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="26"/><path d="M18 31 L26.5 39.5 L43 21"/></svg>'));
    card.appendChild(rooEl("h2", null, "Key activated"));
    card.appendChild(rooEl("p", null, "You're all set. Use the extension from the toolbar popup, or the banner on this page."));
    var ok = rooEl("button", "rs-btn", "OK");
    ok.onclick = function () { _ui.scrim.classList.add("rs-hidden"); _ui.scrim.innerHTML = ""; if (_ui.licensed) rooShowBanner(); };
    card.appendChild(ok);
    _ui.scrim.appendChild(card); _ui.scrim.classList.remove("rs-hidden");
  }
  function rooMakeDraggable(el) {
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    el.style.cursor = "grab";
    el.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      var r = el.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      el.style.right = "auto"; el.style.left = ox + "px"; el.style.top = oy + "px"; el.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      var nx = Math.max(2, Math.min(window.innerWidth - el.offsetWidth - 2, ox + dx));
      var ny = Math.max(2, Math.min(window.innerHeight - el.offsetHeight - 2, oy + dy));
      el.style.left = nx + "px"; el.style.top = ny + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false; el.style.cursor = "grab";
      if (!moved) { try { rooOpenPanel(); } catch (e) {} } // a click (no real drag) → open the panel
      else { try { localStorage.setItem("__rooBnrPos", JSON.stringify({ x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) })); } catch (e) {} }
    });
  }
  function rooShowBanner() {
    rooEnsure(); if (!_ui.licensed) return;
    if (_ui.banner) { _ui.banner.classList.remove("rs-hidden"); return; }
    var lg = rooLogo();
    _ui.banner = rooEl("div", "rs-bnr", '<span class="rs-dot"></span>' + (lg ? '<img src="' + lg + '" alt=""/>' : "") + "<span>Deliveroo Reset</span>");
    rooMakeDraggable(_ui.banner); // drag to move; plain click opens the panel
    _ui.shadow.appendChild(_ui.banner);
    try { var p = JSON.parse(localStorage.getItem("__rooBnrPos") || "null"); if (p && typeof p.x === "number") { _ui.banner.style.right = "auto"; _ui.banner.style.left = p.x + "px"; _ui.banner.style.top = p.y + "px"; } } catch (e) {} // restore saved spot
  }
  function rooHideBanner() { if (_ui.banner) _ui.banner.classList.add("rs-hidden"); }

  // "Update required" overlay — shown when this device is on the wrong extension version.
  function rooShowUpdate(required, current) {
    rooEnsure(); rooHideBanner();
    if (_ui.update) { try { _ui.update.remove(); } catch (e) {} }
    _ui.update = rooEl("div", "rs-scrim");
    var card = rooEl("div", "rs-card");
    card.appendChild(rooEl("h2", null, "Update required"));
    card.appendChild(rooEl("p", null, "You're on <b>v" + (current || "?") + "</b> — the latest is <b>v" + (required || "?") + "</b>. Update to keep using the extension. Your licence is <b>paused</b> (no time lost) until any of your devices updates."));
    card.appendChild(rooEl("div", "rs-steps",
      '<div class="rs-step"><span>1</span> Open the <b>Extensions</b> tab (chrome://extensions)</div>' +
      '<div class="rs-step"><span>2</span> Click <b>Remove</b> on the old version (v' + (current || "?") + ')</div>' +
      '<div class="rs-step"><span>3</span> Click <b>Load unpacked</b> and select the new version folder</div>' +
      '<div class="rs-step"><span>4</span> Refresh this tab to apply the update</div>'));
    var btn = rooEl("a", "rs-btn", "Get the latest version →");
    btn.setAttribute("href", "https://github.com/VisualTFX/deliveroo-ext/releases/"); btn.setAttribute("target", "_blank");
    btn.style.display = "block"; btn.style.textDecoration = "none";
    card.appendChild(btn);
    _ui.update.appendChild(card);
    _ui.shadow.appendChild(_ui.update);
  }
  function rooHideUpdate() { if (_ui.update) { try { _ui.update.remove(); } catch (e) {} _ui.update = null; } }
  function rooClosePanel() { if (_ui.scrim) { _ui.scrim.classList.add("rs-hidden"); _ui.scrim.innerHTML = ""; _ui.scrim.onclick = null; } if (_ui.licensed) rooShowBanner(); }
  // The banner opens the REAL popup embedded in an iframe (runs in the extension context → all the
  // popup's logic works: licence, SMSPool, clear-data, IP reset, etc.).
  function rooOpenPanel() {
    rooEnsure();
    _ui.scrim.innerHTML = "";
    var panel = rooEl("div", "rs-panel");
    var close = rooEl("button", "rs-pclose", "✕"); close.onclick = rooClosePanel;
    var frame = document.createElement("iframe"); frame.className = "rs-frame"; frame.setAttribute("allow", "clipboard-write");
    try { frame.src = chrome.runtime.getURL("popup.html"); } catch (e) {}
    panel.appendChild(close); panel.appendChild(frame);
    _ui.scrim.appendChild(panel);
    _ui.scrim.onclick = function (e) { if (e.target === _ui.scrim) rooClosePanel(); }; // click-outside closes
    _ui.scrim.classList.remove("rs-hidden");
    rooHideBanner();
  }
  function rooSetLicensed(ok) { _ui.licensed = !!ok; if (_ui.licensed) { rooShowBanner(); rooDismissCookies(); } else rooHideBanner(); }

  /* Auto-dismiss the cookie-consent banner via "Continue without accepting". The class names are
     hashed per build, so we match on the stable BUTTON TEXT (the dialog is also role=dialog
     aria-label="tcf.aria_label"). Only acts when licensed, and re-fires after the activation wipe
     when the banner reappears. */
  function rooDismissCookies() {
    if (!_ui.licensed) return false;
    try {
      var btns = document.querySelectorAll('button,[role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (t === "continue without accepting") { btns[i].click(); return true; }
      }
    } catch (e) {}
    return false;
  }
  var _rooCookieObs = null;
  function rooWatchCookies() {
    rooDismissCookies();
    if (_rooCookieObs) return;
    try {
      _rooCookieObs = new MutationObserver(function () { rooDismissCookies(); });
      _rooCookieObs.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (e) {}
  }
  rooWatchCookies(); // observe always; only clicks once licensed

  // On (re)load after activation, the background leaves a flag → show the success UI.
  try {
    chrome.storage.local.get("__activationSuccess", function (d) {
      var t = d && d.__activationSuccess;
      if (t && (Date.now() - t) < 30000) { chrome.storage.local.remove("__activationSuccess"); rooShowSuccess(); }
      else if (t) { chrome.storage.local.remove("__activationSuccess"); } // stale → just clear it
    });
  } catch (e) {}
})();

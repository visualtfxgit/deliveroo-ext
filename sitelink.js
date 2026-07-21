// sitelink.js — content script on dashboard.nexaserve.uk (the NexaServe site).
//
// The extension is gated on the user's website SUBSCRIPTION, not a standalone
// key. This runs first-party on the site, so a same-origin fetch carries the
// (SameSite=Lax, httpOnly) session cookie that the extension's own background
// worker can't. It asks the site for this account's extension-link token + live
// paid status and hands them to the background, which stores them and sends the
// token to the proxy server on each account-creation call.
(function () {
  "use strict";
  if (window.__nsExtLinkRan) return;
  window.__nsExtLinkRan = true;

  function grab() {
    fetch("/api/ext/pass", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.token) return; // not signed in, or the feature is disabled server-side
        try {
          chrome.runtime.sendMessage(
            { type: "extLink", token: d.token, paid: !!d.paid, plan: d.plan || "" },
            function () { void chrome.runtime.lastError; }
          );
        } catch (e) {}
      })
      .catch(function () {});
  }

  // Grab on load, and again if the tab regains focus (covers a fresh login in the
  // same tab, or the subscription changing while the dashboard is open).
  grab();
  window.addEventListener("focus", grab);
})();

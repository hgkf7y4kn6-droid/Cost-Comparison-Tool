// Account & privacy dialog (policy links, delete account, clear this device),
// offline banner and the service worker that makes the web app installable.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const co = window.COMPANY || {};

  // --- Offline banner ---------------------------------------------------------------------
  function syncOnline() {
    $("offline-banner").hidden = navigator.onLine;
  }
  window.addEventListener("online", syncOnline);
  window.addEventListener("offline", syncOnline);
  syncOnline();

  // --- Legal links ----------------------------------------------------------------------------
  document.querySelectorAll("[data-support-email]").forEach((a) => {
    if (co.supportEmail) {
      a.href = `mailto:${co.supportEmail}`;
      a.textContent = co.supportEmail;
    } else {
      a.removeAttribute("href");
      a.textContent = "your administrator";
    }
  });

  // --- AI consent -------------------------------------------------------------------------------
  // AI features send the user's text or photo to a third party (Anthropic). Apple and Google require
  // clear disclosure and permission first, so nothing is sent until the user says yes here.
  const consentKey = () => `ob.ai.consent.${hub.auth ? hub.auth.email : ""}`;
  const readConsent = () => {
    try {
      return localStorage.getItem(consentKey()) || "";
    } catch (_) {
      return "";
    }
  };
  hub.aiConsent = {
    granted: () => !!hub.auth && readConsent() === "granted",
    set(value) {
      try {
        localStorage.setItem(consentKey(), value ? "granted" : "declined");
      } catch (_) {
        // storage unavailable: the choice lasts until reload
      }
      window.dispatchEvent(new CustomEvent("saleshub:aiconsent", { detail: !!value }));
    },
  };
  $("ai-consent-yes").addEventListener("click", () => {
    hub.aiConsent.set(true);
    $("ai-consent").hidden = true;
  });
  $("ai-consent-no").addEventListener("click", () => {
    hub.aiConsent.set(false);
    $("ai-consent").hidden = true;
  });
  window.addEventListener("saleshub:signedin", async () => {
    if (readConsent()) return;
    try {
      const res = await hub.api.fetch("/coach/personas");
      const data = res.ok ? await res.json() : null;
      if (data && data.ai && !readConsent()) $("ai-consent").hidden = false;
    } catch (_) {
      // offline: ask next time
    }
  });

  // --- Dialog -----------------------------------------------------------------------------------
  const dialog = $("acct-dialog");
  let opener = null;

  function open() {
    if (!hub.auth) return;
    opener = document.activeElement;
    $("acct-email").textContent = hub.auth.email + (hub.auth.role === "manager" ? " (manager)" : "");
    $("acct-delete-form").hidden = true;
    $("acct-delete-error").textContent = "";
    $("acct-ai").checked = hub.aiConsent.granted();
    dialog.hidden = false;
    document.body.classList.add("drawer-open");
    $("acct-close").focus();
  }

  function close() {
    dialog.hidden = true;
    document.body.classList.remove("drawer-open");
    if (opener && opener.focus) opener.focus();
  }

  $("auth-account").addEventListener("click", open);
  $("acct-close").addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dialog.hidden) close();
  });

  $("acct-ai").addEventListener("change", (e) => hub.aiConsent.set(e.target.checked));
  $("acct-export").addEventListener("click", () => {
    const s = hub.state;
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), leads: s.leads, quotes: s.quotes, accounts: s.accounts, profile: s.profile, settings: s.settings }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sales-hub-data-${hub.today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $("acct-delete-start").addEventListener("click", () => {
    $("acct-delete-form").hidden = false;
    $("acct-delete-password").focus();
  });

  function wipeDevice() {
    // Everything this app keeps in the browser: leads, quotes, catalog, drafts, sign-in, card state.
    try {
      const keep = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^ob\./.test(k)) keep.push(k);
      }
      keep.forEach((k) => localStorage.removeItem(k));
    } catch (_) {
      // storage unavailable
    }
  }

  $("acct-clear").addEventListener("click", () => {
    if (!confirm("Remove the leads, quotes and catalog stored on this device and sign out? Anything already synced to the server stays there.")) return;
    wipeDevice();
    location.reload();
  });

  $("acct-delete-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("acct-delete-error");
    err.textContent = "";
    const btn = $("acct-delete-go");
    btn.disabled = true;
    try {
      const res = await hub.api.fetch("/auth/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: $("acct-delete-password").value, confirm: $("acct-delete-confirm").value }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || `Couldn't delete the account (${res.status}).`);
      wipeDevice();
      alert("Your account and data have been deleted. You're now signed out.");
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });

  // --- Service worker (web only; the native apps ship the files inside the app) --------------------
  if ("serviceWorker" in navigator && !window.IN_NATIVE_APP && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();

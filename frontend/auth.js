// Sign-in. The backend refuses every API call without a valid bearer token
// (see auth.py); this shows the sign-in screen, keeps the token for the
// session, and gives the other tabs SalesHub.api.fetch / .download, which
// attach it. Report downloads go through fetch too, so the token never ends
// up in a URL.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const API = (window.API_BASE || "http://localhost:8000").replace(/\/$/, "");
  const KEY = "ob.auth.v1";
  const EMAIL_KEY = "ob.auth.lastEmail"; // prefills the sign-in form

  let session = null; // { token, email, expires_at (unix seconds) }
  try {
    session = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch (_) {
    session = null;
  }
  if (!session || !session.token || session.expires_at * 1000 <= Date.now()) session = null;

  function persist() {
    try {
      if (session) localStorage.setItem(KEY, JSON.stringify(session));
      else localStorage.removeItem(KEY);
    } catch (_) {
      // storage unavailable — stays signed in for this page load only
    }
  }

  function setAppInert(inert) {
    for (const el of [document.querySelector("main"), document.querySelector(".tabs")]) {
      if (el) el.inert = inert;
    }
  }

  function showSignIn(message) {
    if (!$("signin-email").value) {
      try {
        $("signin-email").value = localStorage.getItem(EMAIL_KEY) || "";
      } catch (_) {
        // storage unavailable
      }
    }
    $("signin-message").textContent = message || "";
    $("signin-error").textContent = "";
    $("signin").hidden = false;
    $("auth-bar").hidden = true;
    setAppInert(true);
    setTimeout(() => ($("signin-email").value ? $("signin-password") : $("signin-email")).focus(), 0);
  }

  // Other modules read SalesHub.auth ({ email, role }) and listen for these
  // events to load or clear the data that lives on the server.
  function showSignedIn() {
    $("signin").hidden = true;
    $("auth-bar").hidden = false;
    $("auth-user").textContent = session.role === "manager" ? `${session.email} (manager)` : session.email;
    setAppInert(false);
    hub.auth = { email: session.email, role: session.role || "rep" };
    window.dispatchEvent(new CustomEvent("saleshub:signedin", { detail: hub.auth }));
  }

  function signOut(message) {
    session = null;
    hub.auth = null;
    window.dispatchEvent(new CustomEvent("saleshub:signedout"));
    persist();
    $("signin-password").value = "";
    showSignIn(message);
  }

  // Signs out (and asks to sign in again) if the token expired mid-session.
  setInterval(() => {
    if (session && session.expires_at * 1000 <= Date.now()) signOut("Your session expired — please sign in again.");
  }, 60 * 1000);

  async function apiFetch(path, options = {}) {
    if (!session) {
      showSignIn("Please sign in to continue.");
      throw new Error("Please sign in first.");
    }
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${session.token}`);
    let res;
    try {
      res = await fetch(`${API}${path}`, { ...options, headers });
    } catch (err) {
      throw new Error(`Connection failed: ${err.message}`);
    }
    if (res.status === 401) {
      signOut("Your session expired — please sign in again.");
      throw new Error("Your session expired. Sign in and try again.");
    }
    return res;
  }

  async function apiDownload(path) {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error(`Download failed (${res.status}).`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = path.split("/").pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button[type=submit]");
    $("signin-error").textContent = "";
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      let res;
      try {
        res = await fetch(`${API}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: $("signin-email").value, password: $("signin-password").value }),
        });
      } catch (err) {
        throw new Error(`Couldn't reach the server (${err.message}). It may be starting up — try again in a minute.`);
      }
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        // non-JSON error body
      }
      if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || `Sign-in failed (${res.status}).`);
      session = { token: data.token, email: data.email, expires_at: data.expires_at, role: data.role || "rep" };
      persist();
      try {
        localStorage.setItem(EMAIL_KEY, data.email);
      } catch (_) {
        // storage unavailable
      }
      $("signin-password").value = "";
      showSignedIn();
    } catch (err) {
      $("signin-error").textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });

  $("auth-signout").addEventListener("click", () => signOut("You've signed out."));

  hub.api = { fetch: apiFetch, download: apiDownload, base: API };

  if (session) {
    showSignedIn();
    // Confirms the stored token is still accepted (e.g. not revoked by a password change).
    apiFetch("/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => {
        // Picks up role changes (e.g. made a manager) without signing in again.
        if (me && session && me.role && me.role !== session.role) {
          session.role = me.role;
          persist();
          showSignedIn();
        }
      })
      .catch(() => {});
  } else {
    showSignIn();
  }
})();

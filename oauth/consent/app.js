// Jarvis Brain consent UI for GitHub Pages.
// Official client methods, pinned with @supabase/supabase-js 2.95.0:
//   supabase.auth.oauth.getAuthorizationDetails(authorizationId)
//   supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
//   supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
//   supabase.auth.oauth.revokeGrant({ clientId })
// skipBrowserRedirect is required. The library would otherwise leave for the
// MCP client before the Brain binding exists.
(function () {
  const GROK_REDIRECT = "https://www.cursor.com/agents/mcp/oauth/callback";
  const ID_KEY = "jarvis-brain-authorization-id";
  const config = window.JARVIS_BRAIN_CONSENT;
  const el = (id) => document.getElementById(id);
  const state = {
    authorizationId: null,
    mode: "login",
    clientId: null,
    redirectUri: "",
    redirectUrl: "",
    grantable: false,
  };

  function setStatus(text) {
    el("status").textContent = text;
  }

  function authorizationIdFromLocation() {
    const fromQuery = new URL(window.location.href).searchParams.get("authorization_id");
    if (fromQuery && /^[A-Za-z0-9]{32}$/.test(fromQuery)) {
      sessionStorage.setItem(ID_KEY, fromQuery);
      return fromQuery;
    }
    const stored = sessionStorage.getItem(ID_KEY) || "";
    return /^[A-Za-z0-9]{32}$/.test(stored) ? stored : null;
  }

  function returnUrl(authorizationId) {
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    url.searchParams.set("authorization_id", authorizationId);
    return url.toString();
  }

  function cursorCallback(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && url.origin === "https://www.cursor.com"
        && url.pathname === "/agents/mcp/oauth/callback"
        && url.username === ""
        && url.password === "";
    } catch {
      return false;
    }
  }

  function show(id, visible) {
    el(id).classList.toggle("hidden", !visible);
  }

  function renderScopes(scope) {
    const list = el("scopes");
    list.replaceChildren();
    const parts = String(scope || "").split(" ").map((item) => item.trim()).filter(Boolean);
    if (!parts.length) {
      const item = document.createElement("li");
      item.textContent = "Keine zusätzlichen Scopes angegeben";
      list.append(item);
      return;
    }
    for (const part of parts) {
      const item = document.createElement("li");
      item.textContent = part;
      list.append(item);
    }
  }

  function renderFacts(name, redirectUri, scope, grantable) {
    el("client").textContent = name || "Unbenannte Anwendung";
    el("redirect").textContent = redirectUri || "Nicht angegeben";
    renderScopes(scope);
    state.redirectUri = redirectUri || "";
    state.grantable = grantable === true && redirectUri === GROK_REDIRECT;
    el("grant-note").textContent = state.grantable
      ? "Eine Genehmigung legt für Grok Bot eine Brain-Freigabe von sieben Tagen an. Direkte Änderungen an bestätigtem Wissen bleiben ausgeschlossen."
      : "Diese Weiterleitungsadresse ist für eine Brain-Freigabe nicht zugelassen. Ablehnen ist möglich; Genehmigen vergibt keinen Brain-Zugriff.";
  }

  async function api(path, body) {
    const session = await sb.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) throw new Error("Keine gültige Anmeldung.");
    const response = await fetch(config.consentApi + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
        apikey: config.supabaseKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Serverfehler");
    return result;
  }

  function setBusy(busy) {
    el("approve").disabled = busy || !el("confirm").checked || !state.grantable;
    el("deny").disabled = busy;
    el("send").disabled = busy;
  }

  async function failClosed(clientId) {
    if (!clientId) return;
    try { await api("/api/revoke", {oauth_client_id: clientId}); } catch { /* no binding yet */ }
    const revoked = await sb.auth.oauth.revokeGrant({clientId});
    if (revoked.error) throw new Error(revoked.error.message);
  }

  async function loadBindings() {
    const data = await api("/api/bindings");
    const host = el("bindings");
    host.replaceChildren();
    if (!data.bindings.length) {
      host.textContent = "Keine gespeicherten Client-Freigaben.";
      return;
    }
    for (const binding of data.bindings) {
      const block = document.createElement("div");
      block.className = "binding";
      const text = document.createElement("p");
      text.textContent = `${binding.principal} · ${binding.oauth_client_id} · ${binding.enabled ? "aktiv" : "deaktiviert"} · bis ${binding.expires_at || "ohne Datum"}`;
      block.append(text);
      if (binding.enabled && binding.oauth_client_id) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "Freigabe widerrufen";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await failClosed(binding.oauth_client_id);
            setStatus("Brain-Freigabe deaktiviert und OAuth-Grant widerrufen.");
            await loadBindings();
          } catch (error) {
            setStatus("Widerruf unvollständig: " + error.message);
            button.disabled = false;
          }
        });
        block.append(button);
      }
      host.append(block);
    }
  }

  async function showAccount() {
    const user = await sb.auth.getUser();
    if (!user.data.user) {
      show("login", Boolean(state.authorizationId));
      show("approval", false);
      show("account", false);
      setStatus(state.authorizationId
        ? "Melde dich mit deinem freigeschalteten Brain-Besitzerkonto an."
        : "Kein OAuth-Auftrag vorhanden. Bitte die Anmeldung aus Grok Bot erneut starten.");
      return;
    }
    show("login", false);
    show("account", true);
    el("who").textContent = user.data.user.email || user.data.user.id;
    try {
      await loadBindings();
    } catch (error) {
      el("bindings").textContent = error.message;
    }
    if (!state.authorizationId) {
      show("approval", false);
      setStatus("Angemeldet. Starte die Verbindung erneut aus Grok Bot, um einen Client freizugeben.");
      return;
    }
    await loadAuthorization();
  }

  async function loadAuthorization() {
    if (state.redirectUrl) return;
    const details = await sb.auth.oauth.getAuthorizationDetails(state.authorizationId);
    if (details.error || !details.data) {
      show("approval", false);
      setStatus("OAuth-Auftrag nicht lesbar: " + (details.error?.message || "keine Angaben"));
      return;
    }
    const preview = await api("/api/authorization?authorization_id=" + encodeURIComponent(state.authorizationId));
    state.clientId = preview.clientId || details.data.client?.id || null;
    const name = "authorization_id" in details.data ? details.data.client?.name : preview.clientName;
    const redirectUri = "authorization_id" in details.data ? details.data.redirect_uri : preview.redirectUri;
    const scope = "authorization_id" in details.data ? details.data.scope : preview.scope;
    const grantable = preview.grantable === true && redirectUri === GROK_REDIRECT;
    if (!("authorization_id" in details.data) && details.data.redirect_url) {
      state.mode = "continue";
      state.redirectUrl = details.data.redirect_url;
      renderFacts(name, redirectUri, scope, grantable);
      el("approval-title").textContent = "Vorherige Zustimmung";
      el("approve").textContent = "Geprüft fortsetzen";
      el("deny").classList.add("hidden");
      show("approval", true);
      setStatus("Supabase hat eine frühere Zustimmung erkannt. Brain-Zugriff entsteht erst, wenn du nach der Prüfung fortsetzt.");
      setBusy(false);
      return;
    }
    if (preview.status === "approved") {
      state.mode = "restart";
      state.redirectUrl = "";
      renderFacts(name, redirectUri, scope, false);
      show("approval", true);
      el("approve").disabled = true;
      el("deny").classList.add("hidden");
      setStatus("Dieser Auftrag ist bereits genehmigt, die Rückleitung ist nicht mehr vorhanden. Bitte die Anmeldung in Grok Bot neu starten.");
      return;
    }
    state.mode = "consent";
    state.redirectUrl = "";
    renderFacts(name, redirectUri, scope, grantable);
    el("approval-title").textContent = "Verbindung prüfen";
    el("approve").textContent = "Verbindung genehmigen";
    el("deny").classList.remove("hidden");
    show("approval", true);
    setStatus("Prüfe die Angaben. Die Freigabe wird erst mit dem Genehmigen-Klick erteilt.");
    setBusy(false);
  }

  const sb = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      flowType: "implicit",
    },
  });

  el("confirm").addEventListener("change", () => setBusy(false));
  el("send").addEventListener("click", async () => {
    const email = el("mail").value.trim();
    if (!email || !state.authorizationId) {
      setStatus("E-Mail und ein OAuth-Auftrag werden benötigt.");
      return;
    }
    setBusy(true);
    const {error} = await sb.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: returnUrl(state.authorizationId),
      },
    });
    setStatus(error
      ? "Anmeldung nicht gestartet: " + error.message
      : "Öffne den Anmeldelink in derselben Browser-Sitzung. Der OAuth-Auftrag bleibt in der Adresse erhalten.");
    setBusy(false);
  });

  el("approve").addEventListener("click", async () => {
    if (!el("confirm").checked || !state.grantable || !state.authorizationId || state.mode === "restart") return;
    setBusy(true);
    try {
      let redirectUrl = state.redirectUrl;
      if (state.mode === "consent") {
        const approved = await sb.auth.oauth.approveAuthorization(state.authorizationId, {skipBrowserRedirect: true});
        if (approved.error || !approved.data?.redirect_url) {
          throw new Error(approved.error?.message || "OAuth-Genehmigung fehlgeschlagen");
        }
        redirectUrl = approved.data.redirect_url;
      }
      if (!cursorCallback(redirectUrl) || state.redirectUri !== GROK_REDIRECT) {
        throw new Error("Die Rückleitungsadresse passt nicht zur geprüften Anwendung.");
      }
      await api("/api/bind", {authorization_id: state.authorizationId});
      window.location.assign(redirectUrl);
    } catch (error) {
      state.redirectUrl = "";
      state.mode = "restart";
      try {
        await failClosed(state.clientId);
      } catch {
        setStatus("Verbindung nicht abgeschlossen: " + error.message + " Der OAuth-Grant konnte zusätzlich nicht widerrufen werden.");
        setBusy(false);
        return;
      }
      setStatus("Verbindung nicht abgeschlossen: " + error.message);
      setBusy(false);
    }
  });

  el("deny").addEventListener("click", async () => {
    if (!state.authorizationId || state.mode !== "consent") return;
    setBusy(true);
    try {
      const denied = await sb.auth.oauth.denyAuthorization(state.authorizationId, {skipBrowserRedirect: true});
      if (denied.error || !denied.data?.redirect_url) {
        throw new Error(denied.error?.message || "Ablehnung fehlgeschlagen");
      }
      if (!cursorCallback(denied.data.redirect_url)) {
        throw new Error("Die Rückleitungsadresse passt nicht zur geprüften Anwendung.");
      }
      window.location.assign(denied.data.redirect_url);
    } catch (error) {
      setStatus("Ablehnung nicht abgeschlossen: " + error.message);
      setBusy(false);
    }
  });

  el("signout").addEventListener("click", async () => {
    await sb.auth.signOut();
    await showAccount();
  });

  let accountQueue = Promise.resolve();
  function queueAccount() {
    accountQueue = accountQueue
      .then(() => showAccount())
      .catch((error) => setStatus(error instanceof Error ? error.message : "Anmeldung fehlgeschlagen"));
  }

  state.authorizationId = authorizationIdFromLocation();
  sb.auth.onAuthStateChange(() => queueAccount());
  queueAccount();
})();

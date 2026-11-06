// Owner console for https://jafrijafri.github.io/jarvis-brain-consent/console/
// Uses the publishable key in ../config.js. Never a service-role key.
(function () {
  const config = window.JARVIS_BRAIN_CONSENT;
  const el = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      flowType: "implicit",
    },
  });

  function setStatus(text) {
    el("status").textContent = text;
  }

  function toggle(id, visible) {
    el(id).classList.toggle("hidden", !visible);
  }

  function returnUrl() {
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    return url.toString();
  }

  async function api(path, body, accessToken) {
    let token = accessToken;
    if (!token) {
      const session = await sb.auth.getSession();
      token = session.data.session?.access_token;
    }
    if (!token) throw new Error("Nicht angemeldet");
    const response = await fetch(config.consoleApi + path, {
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

  function block(title, meta, detail) {
    const host = document.createElement("div");
    host.className = "fact";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const small = document.createElement("p");
    small.className = "muted";
    small.textContent = meta;
    const pre = document.createElement("pre");
    pre.textContent = detail;
    host.append(heading, small, pre);
    return host;
  }

  function actions(kind, id) {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Freigeben";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary";
    reject.textContent = "Ablehnen";
    const act = async (decision) => {
      if (!window.confirm((decision === "approve" ? "Freigeben" : "Ablehnen") + "?")) return;
      approve.disabled = true;
      reject.disabled = true;
      try {
        await api("/api/decide", {kind, id, decision});
        setStatus("Entscheidung gespeichert.");
            await refreshLists();
      } catch (error) {
        setStatus("Entscheidung nicht gespeichert: " + error.message);
        approve.disabled = false;
        reject.disabled = false;
      }
    };
    approve.addEventListener("click", () => act("approve"));
    reject.addEventListener("click", () => act("reject"));
    const wrap = document.createElement("div");
    wrap.append(approve, reject);
    return wrap;
  }

  async function loadLists(token) {
    if (!token) throw new Error("Nicht angemeldet");
    const [pending, bindings, receipts, grants] = await Promise.all([
      api("/api/pending", undefined, token),
      api("/api/bindings", undefined, token),
      api("/api/receipts", undefined, token),
      api("/api/grants", undefined, token),
    ]);
    el("overview").textContent = "Bestätigte Einträge: " + pending.total_confirmed
      + " | Offene Erinnerungen: " + pending.memory.length
      + " | Neue Bereiche: " + pending.structure.length;
    const memories = el("memories");
    memories.replaceChildren();
    if (!pending.memory.length) memories.textContent = "Keine offenen Vorschläge.";
    for (const entry of pending.memory) {
      const card = block(
        entry.proposed_content?.title || entry.proposed_type,
        entry.submitted_by + " | " + entry.id,
        JSON.stringify(entry.proposed_content, null, 2),
      );
      card.append(actions("memory", entry.id));
      memories.append(card);
    }
    const structures = el("structures");
    structures.replaceChildren();
    if (!pending.structure.length) structures.textContent = "Keine offenen Bereiche.";
    for (const entry of pending.structure) {
      const card = block(
        entry.proposed_title,
        entry.submitted_by + " | " + entry.proposed_kind,
        JSON.stringify({
          parent_space_id: entry.parent_space_id,
          slug: entry.proposed_slug,
          rationale: entry.rationale,
        }, null, 2),
      );
      card.append(actions("space", entry.id));
      structures.append(card);
    }
    const bindingHost = el("bindings");
    bindingHost.replaceChildren();
    if (!bindings.bindings.length) bindingHost.textContent = "Keine Client-Freigaben.";
    for (const binding of bindings.bindings) {
      const card = block(
        binding.principal || "principal",
        (binding.enabled ? "aktiv" : "deaktiviert") + " | bis " + (binding.expires_at || "ohne Datum"),
        binding.oauth_client_id || binding.id,
      );
      if (binding.enabled) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "Freigabe widerrufen";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await api("/api/revoke", {id: binding.id});
            setStatus("Client-Freigabe deaktiviert.");
            await refreshLists();
          } catch (error) {
            setStatus("Widerruf nicht gespeichert: " + error.message);
            button.disabled = false;
          }
        });
        card.append(button);
      }
      bindingHost.append(card);
    }
    const receiptHost = el("receipts");
    receiptHost.replaceChildren();
    if (!receipts.receipts.length) receiptHost.textContent = "Noch keine Werkzeugaufrufe.";
    for (const receipt of receipts.receipts) {
      receiptHost.append(block(
        receipt.tool_name,
        receipt.principal + " | " + receipt.received_at,
        receipt.result_preview || "",
      ));
    }
    const grantHost = el("grants");
    grantHost.replaceChildren();
    for (const grant of grants.grants) {
      grantHost.append(block(
        grant.principal + " / " + grant.space_slug,
        grant.space_title + " | bis " + (grant.expires_at || "ohne Datum"),
        "read=" + grant.can_read + " propose=" + grant.can_propose
          + " report=" + grant.can_report + " write=" + grant.can_write,
      ));
    }
    el("daily").textContent = pending.latest_check
      ? JSON.stringify(pending.latest_check, null, 2)
      : "Noch kein Tagescheck";
  }

  async function refreshLists() {
    const session = await sb.auth.getSession();
    await loadLists(session.data.session?.access_token);
  }

  // The session object comes from the auth event. Rendering must not call
  // getUser() or getSession(); those calls can emit another auth event.
  async function applySession(session) {
    if (!session?.user) {
      toggle("login", true);
      toggle("app", false);
      setStatus("Mit dem Besitzerkonto anmelden.");
      return;
    }
    toggle("login", false);
    toggle("app", true);
    el("who").textContent = session.user.email || session.user.id;
    try {
      await loadLists(session.access_token);
      setStatus("");
    } catch (error) {
      setStatus("Zugriff nicht freigegeben: " + error.message);
    }
  }

  let renderEpoch = 0;
  let shownToken = null;
  function scheduleRender(session) {
    const epoch = ++renderEpoch;
    setTimeout(() => {
      if (epoch !== renderEpoch) return;
      const token = session?.access_token || "";
      if (token === shownToken) return;
      shownToken = token;
      void applySession(session);
    }, 0);
  }

  el("password-signin").addEventListener("click", async () => {
    const email = el("email").value.trim();
    const password = el("password").value;
    if (!email || !password) {
      setStatus("E-Mail und Passwort werden benötigt.");
      return;
    }
    const {error} = await sb.auth.signInWithPassword({email, password});
    setStatus(error ? "Anmeldung nicht möglich: " + error.message : "Angemeldet.");
  });

  el("magic").addEventListener("click", async () => {
    const email = el("email").value.trim();
    if (!email) {
      setStatus("E-Mail wird benötigt.");
      return;
    }
    const {error} = await sb.auth.signInWithOtp({
      email,
      options: {shouldCreateUser: false, emailRedirectTo: returnUrl()},
    });
    setStatus(error
      ? "Anmeldelink nicht gesendet: " + error.message
      : "Öffne den Anmeldelink in dieser Browser-Sitzung.");
  });

  el("signout").addEventListener("click", async () => {
    await sb.auth.signOut();
  });
  el("reload").addEventListener("click", () => {
    void refreshLists().catch((error) => {
      setStatus("Zugriff nicht freigegeben: " + error.message);
    });
  });
  el("google-tasks-connect").addEventListener("click", async () => {
    const button = el("google-tasks-connect");
    button.disabled = true;
    try {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error("Nicht angemeldet");
      const response = await fetch(config.supabaseUrl + "/functions/v1/google-tasks/oauth/start", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          apikey: config.supabaseKey,
        },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || typeof result.authorization_url !== "string" || !result.authorization_url) {
        throw new Error(result.error || "Google Tasks konnte nicht gestartet werden.");
      }
      window.location.href = result.authorization_url;
    } catch (error) {
      setStatus(error.message);
      button.disabled = false;
    }
  });
  // callbackLocation("connected" | "error") sends the owner back here.
  const googleTasksUrl = new URL(window.location.href);
  const googleTasks = googleTasksUrl.searchParams.get("google_tasks");
  if (googleTasks === "connected" || googleTasks === "error") {
    const banner = el("google-tasks");
    banner.textContent = googleTasks === "connected"
      ? "Google Tasks ist verbunden."
      : "Google Tasks konnte nicht verbunden werden.";
    banner.classList.remove("hidden");
    googleTasksUrl.searchParams.delete("google_tasks");
    window.history.replaceState(null, "", googleTasksUrl.pathname + googleTasksUrl.search + googleTasksUrl.hash);
  }
  // Render only for the first session and for a real sign-in or sign-out.
  // TOKEN_REFRESHED is ignored: a refresh must not schedule another render.
  // The callback itself does not read the session; that would re-enter the lock.
  let initialSessionHandled = false;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION") {
      if (initialSessionHandled) return;
      initialSessionHandled = true;
    } else if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") {
      return;
    }
    scheduleRender(event === "SIGNED_OUT" ? null : session);
  });
})();

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
        await load();
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

  // show() and load() share one render. A burst of auth events coalesces into
  // the current run plus at most one follow-up, so the four console calls
  // cannot overlap or queue without bound. A pending show() wins over load():
  // it already refreshes the lists when the user is still signed in.
  let viewRunning = false;
  let viewAgain = null;

  function runView(kind, task) {
    let resolve, reject;
    const result = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const waiter = {resolve, reject};
    if (viewRunning) {
      const waiters = viewAgain ? viewAgain.waiters : [];
      waiters.push(waiter);
      if (!viewAgain || kind === "show" || viewAgain.kind !== "show") {
        viewAgain = {kind, task, waiters};
      } else {
        viewAgain.waiters = waiters;
      }
      return result;
    }
    viewRunning = true;
    let current = {kind, task, waiters: [waiter]};
    void (async () => {
      try {
        while (current) {
          viewAgain = null;
          try {
            await current.task();
            for (const item of current.waiters) item.resolve();
          } catch (error) {
            for (const item of current.waiters) item.reject(error);
          }
          current = viewAgain;
        }
      } finally {
        viewRunning = false;
      }
    })();
    return result;
  }

  function load() {
    return runView("load", loadLists);
  }

  async function loadLists() {
    const session = await sb.auth.getSession();
    const token = session.data.session?.access_token;
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
            await load();
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

  function show() {
    return runView("show", async () => {
      const user = await sb.auth.getUser();
      if (!user.data.user) {
        toggle("login", true);
        toggle("app", false);
        setStatus("Mit dem Besitzerkonto anmelden.");
        return;
      }
      toggle("login", false);
      toggle("app", true);
      el("who").textContent = user.data.user.email || user.data.user.id;
      try {
        await loadLists();
        setStatus("");
      } catch (error) {
        setStatus("Zugriff nicht freigegeben: " + error.message);
      }
    });
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
    if (!error) await show();
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
    await show();
  });
  el("reload").addEventListener("click", () => show());
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
  // TOKEN_REFRESHED must not reload. getSession() can refresh the access token,
  // which would emit another event and call show() again. INITIAL_SESSION is
  // applied once; the direct show() below is that first render.
  let initialSessionHandled = false;
  sb.auth.onAuthStateChange((event) => {
    if (event === "INITIAL_SESSION") {
      if (initialSessionHandled) return;
      initialSessionHandled = true;
    } else if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") {
      return;
    }
    setTimeout(() => { void show(); }, 0);
  });
  initialSessionHandled = true;
  void show();
})();

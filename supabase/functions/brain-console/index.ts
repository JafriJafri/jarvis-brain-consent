// Jarvis Brain owner console API. JSON only.
// Deploy this directory (index.ts and policy.ts) with verify_jwt disabled.
// Supabase injects SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_DB_URL.
// The function never inserts brain_access.owners and never returns HTML.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.7";
import {
  CONSOLE_UI,
  assessOwnerSession,
  consoleRoute,
  corsHeaders,
  expectedIssuer,
  parseUuid,
  validateDecision,
  validateMemoryContent,
} from "./policy.ts";

const sb = Deno.env.get("SUPABASE_URL") || "";
const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
const db = postgres(Deno.env.get("SUPABASE_DB_URL") || "", {
  max: 2, idle_timeout: 8, connect_timeout: 7, ssl: "require", prepare: false,
});
type Sql = (query: string, args?: unknown[]) => Promise<Record<string, unknown>[]>;
const query: Sql = (statement, args = []) => db.unsafe(statement, args as never[]);

class ConsoleError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
  }
}

function json(req: Request, status: number, body: unknown): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const cors = corsHeaders(req.headers.get("Origin"));
  if (cors) Object.assign(headers, cors);
  return new Response(JSON.stringify(body), {status, headers});
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodePayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || part.length > 8192)) {
    throw new ConsoleError(401, "Anmeldung ungültig", "auth");
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    throw new ConsoleError(401, "Anmeldung ungültig", "auth");
  }
}

async function owner(req: Request): Promise<string> {
  if (!sb || !anon || !Deno.env.get("SUPABASE_DB_URL")) {
    throw new ConsoleError(503, "Serverkonfiguration unvollständig", "config");
  }
  const header = /^Bearer (.+)$/i.exec(req.headers.get("Authorization") || "");
  if (!header || header[1].length > 8192) throw new ConsoleError(401, "Anmeldung ungültig", "auth");
  const claims = decodePayload(header[1]);
  const response = await fetch(`${sb}/auth/v1/user`, {
    method: "GET",
    redirect: "error",
    headers: {apikey: anon, Authorization: `Bearer ${header[1]}`},
  });
  if (!response.ok) throw new ConsoleError(401, "Anmeldung abgelaufen", "auth");
  const user = await response.json();
  if (typeof user?.id !== "string") throw new ConsoleError(401, "Unbekannte Anmeldung", "auth");
  let issuer: string;
  try {
    issuer = expectedIssuer(sb);
  } catch {
    throw new ConsoleError(503, "Serverkonfiguration unvollständig", "config");
  }
  if (!assessOwnerSession(claims, Date.now(), issuer, user.id)) {
    throw new ConsoleError(401, "Anmeldung ungültig", "auth");
  }
  const owners = await query(
    "select auth_user_id from brain_access.owners where auth_user_id=$1::uuid limit 1",
    [user.id],
  );
  if (!owners.length) throw new ConsoleError(403, "Besitzerkonto muss erst freigeschaltet werden", "not_owner");
  return user.id;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new ConsoleError(415, "JSON erforderlich", "content_type");
  }
  const raw = await req.text();
  if (raw.length > 8000) throw new ConsoleError(413, "Anfrage zu groß", "too_large");
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    throw new ConsoleError(400, "Ungültiges JSON", "json");
  }
}

async function pending() {
  const [memory, structure, count, health] = await Promise.all([
    query(
      "select id, proposed_type, proposed_content, proposed_space_id, target_item_id, submitted_by, created_at " +
        "from brain_governance.memory_proposals where status='pending' order by created_at asc limit 100",
    ),
    query(
      "select id, parent_space_id, proposed_slug, proposed_title, proposed_kind, rationale, submitted_by, created_at " +
        "from brain_governance.structure_proposals where status='pending' order by created_at asc limit 100",
    ),
    query("select count(*)::integer as total from brain.items where status='confirmed'"),
    query("select review_date, checked_at, memories_count, proposed_count, pending_approvals_count from brain_audit.daily_health_checks order by review_date desc limit 1"),
  ]);
  return {
    memory,
    structure,
    total_confirmed: count[0]?.total ?? 0,
    latest_check: health[0] ?? null,
  };
}

async function decide(userId: string, body: Record<string, unknown>) {
  const parsed = validateDecision(body);
  if (!parsed.ok) throw new ConsoleError(parsed.status, parsed.error, parsed.code);
  const {id, decision, kind} = parsed.value;
  return db.begin(async (tx) => {
    const sql: Sql = (statement, args = []) => tx.unsafe(statement, args as never[]);
    const table = kind === "memory"
      ? "brain_governance.memory_proposals"
      : "brain_governance.structure_proposals";
    const proposals = await sql(`select * from ${table} where id=$1::uuid for update`, [id]);
    if (!proposals.length || proposals[0].status !== "pending") {
      throw new ConsoleError(409, "Proposal not pending", "not_pending");
    }
    const proposal = proposals[0];
    let itemId: string | null = null;
    if (decision === "approve" && kind === "memory") {
      const content = validateMemoryContent(proposal.proposed_type, proposal.proposed_content);
      if (!content.ok) throw new ConsoleError(content.status, content.error, content.code);
      if (proposal.proposed_type === "create") {
        if (!proposal.proposed_space_id || !proposal.source_document_id) {
          throw new ConsoleError(400, "Missing type/scope/provenance", "provenance");
        }
        const exists = await sql(
          "select 1 from brain_sources.documents where id=$1::uuid and space_id=$2::uuid",
          [proposal.source_document_id, proposal.proposed_space_id],
        );
        if (!exists.length) throw new ConsoleError(400, "Source not attached to requested scope", "provenance");
        if (!content.itemType) throw new ConsoleError(400, "Missing type/scope/provenance", "type");
        const rows = await sql(
          "insert into brain.items(space_id,topic_id,title,body,item_type,status,classification,created_by) " +
            "values($1::uuid,$2::uuid,$3,$4,$5,'confirmed','private',$6) returning id",
          [proposal.proposed_space_id, proposal.proposed_topic_id, content.title, content.body,
            content.itemType, `owner-approved:${userId}`],
        );
        itemId = asText(rows[0]?.id) || null;
      } else if (proposal.proposed_type === "revise") {
        if (!proposal.target_item_id || !proposal.source_document_id || !proposal.proposed_space_id) {
          throw new ConsoleError(400, "Missing revision target or source", "provenance");
        }
        const current = await sql(
          "select id, version_no, title, body, item_type, status, space_id, metadata, created_by, updated_at " +
            "from brain.items where id=$1::uuid and status='confirmed' and space_id=$2::uuid for update",
          [proposal.target_item_id, proposal.proposed_space_id],
        );
        if (!current.length) throw new ConsoleError(409, "Revision target no longer current", "target");
        const row = current[0];
        await sql(
          "insert into brain.item_versions(item_id,version_no,snapshot) values($1::uuid,$2,$3::jsonb) " +
            "on conflict(item_id,version_no) do nothing",
          [row.id, row.version_no, JSON.stringify({
            id: row.id, space_id: row.space_id, title: row.title, body: row.body,
            item_type: row.item_type, status: row.status, version_no: row.version_no,
            metadata: row.metadata, created_by: row.created_by, updated_at: row.updated_at,
          })],
        );
        const rows = await sql(
          "update brain.items set title=$2, body=$3, created_by=$4 " +
            "where id=$1::uuid and status='confirmed' and space_id=$5::uuid returning id, version_no",
          [proposal.target_item_id, content.title, content.body, `owner-approved:${userId}`, proposal.proposed_space_id],
        );
        if (!rows.length) throw new ConsoleError(409, "Revision target no longer current", "target");
        itemId = asText(rows[0].id);
      }
      if (itemId) {
        await sql(
          "insert into brain_sources.item_sources(item_id,document_id,citation_label) " +
            "values($1::uuid,$2::uuid,'Approved client-proposed source') on conflict do nothing",
          [itemId, proposal.source_document_id],
        );
      }
    }
    if (decision === "approve" && kind === "space") {
      if (!proposal.parent_space_id) throw new ConsoleError(400, "Root space changes require manual review", "root");
      const parent = await sql(
        "select classification from brain.spaces where id=$1::uuid and lifecycle='active'",
        [proposal.parent_space_id],
      );
      if (!parent.length) throw new ConsoleError(400, "Parent no longer active", "parent");
      if (proposal.proposed_kind === "topic") {
        const rows = await sql(
          "insert into brain.topics(space_id,slug,title) values($1::uuid,$2,$3) on conflict do nothing returning id",
          [proposal.parent_space_id, proposal.proposed_slug, proposal.proposed_title],
        );
        itemId = asText(rows[0]?.id) || null;
      } else {
        const kindValue = proposal.proposed_kind === "area" ? "project" : proposal.proposed_kind;
        const rows = await sql(
          "insert into brain.spaces(parent_id,slug,title,kind,classification) " +
            "values($1::uuid,$2,$3,$4,$5) on conflict do nothing returning id",
          [proposal.parent_space_id, proposal.proposed_slug, proposal.proposed_title, kindValue, parent[0].classification],
        );
        itemId = asText(rows[0]?.id) || null;
      }
    }
    await sql(`update ${table} set status=$2, resolved_at=now() where id=$1::uuid`, [
      id, decision === "approve" ? "approved" : "rejected",
    ]);
    await sql(
      "insert into brain_governance.approval_receipts(" +
        (kind === "memory" ? "proposal_id" : "structure_proposal_id") +
        ",verified_user_id,decision,evidence_id) values($1::uuid,$2::uuid,$3,$4)",
      [id, userId, decision, crypto.randomUUID()],
    );
    return {ok: true, kind, id, decision, published_id: itemId};
  });
}

async function bindings() {
  const rows = await query(
    "select b.id, b.auth_user_id, b.oauth_client_id, p.slug as principal, b.enabled, b.expires_at, b.created_at " +
      "from brain_access.client_bindings b join brain_governance.principals p on p.id=b.principal_id " +
      "order by b.created_at desc limit 50",
  );
  return {bindings: rows};
}

async function revoke(body: Record<string, unknown>) {
  const id = parseUuid(body.id);
  if (!id) throw new ConsoleError(400, "Invalid ID", "id");
  const rows = await query(
    "update brain_access.client_bindings set enabled=false where id=$1::uuid " +
      "returning id, oauth_client_id, enabled, expires_at",
    [id],
  );
  if (!rows.length) throw new ConsoleError(404, "Keine Freigabe mit dieser ID", "binding_missing");
  return {ok: true, binding: rows[0]};
}

async function receipts() {
  const rows = await query(
    "select r.id, p.slug as principal, r.tool_name, r.request_key, r.received_at, left(r.result::text, 500) as result_preview " +
      "from brain_access.tool_receipts r join brain_governance.principals p on p.id=r.principal_id " +
      "order by r.received_at desc limit 40",
  );
  return {receipts: rows};
}

async function grants() {
  const rows = await query(
    "select p.slug as principal, s.slug as space_slug, s.title as space_title, " +
      "g.can_read, g.can_propose, g.can_report, g.can_write, g.expires_at " +
      "from brain_governance.grants g " +
      "join brain_governance.principals p on p.id=g.principal_id " +
      "join brain.spaces s on s.id=g.space_id " +
      "order by p.slug, s.slug limit 200",
  );
  return {grants: rows};
}

Deno.serve(async (req: Request) => {
  const path = consoleRoute(new URL(req.url).pathname);
  if (req.method === "OPTIONS") {
    const cors = corsHeaders(req.headers.get("Origin"));
    if (!cors) return json(req, 403, {error: "Origin nicht erlaubt", code: "origin"});
    return new Response(null, {status: 204, headers: {...cors, "cache-control": "no-store"}});
  }
  if (req.method === "GET" && path === "/") {
    return json(req, 200, {service: "brain-console", html: false, ui: CONSOLE_UI});
  }
  if (!corsHeaders(req.headers.get("Origin"))) {
    return json(req, 403, {error: "Origin nicht erlaubt", code: "origin"});
  }
  try {
    const userId = await owner(req);
    if (req.method === "GET" && path === "/api/pending") {
      return json(req, 200, {...await pending(), owner_user_id: userId});
    }
    if (req.method === "GET" && path === "/api/bindings") return json(req, 200, await bindings());
    if (req.method === "GET" && path === "/api/receipts") return json(req, 200, await receipts());
    if (req.method === "GET" && path === "/api/grants") return json(req, 200, await grants());
    if (req.method === "POST" && path === "/api/decide") {
      return json(req, 200, await decide(userId, await readJson(req)));
    }
    if (req.method === "POST" && path === "/api/revoke") {
      return json(req, 200, await revoke(await readJson(req)));
    }
    return json(req, 404, {error: "Unbekannte Anfrage", code: "not_found"});
  } catch (error) {
    if (error instanceof ConsoleError) return json(req, error.status, {error: error.message, code: error.code});
    console.error("brain-console failure", error instanceof Error ? error.name : "unknown");
    return json(req, 500, {error: "Interner Fehler", code: "internal"});
  }
});

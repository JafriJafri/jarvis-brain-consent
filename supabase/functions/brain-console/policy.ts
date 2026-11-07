// Owner-console authorization rules. Deploy this file with index.ts.
// The function never inserts brain_access.owners.

export const PAGES_ORIGIN = "https://jafrijafri.github.io";
export const CONSOLE_UI = "https://jafrijafri.github.io/jarvis-brain-consent/console/";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MEMORY_CONTENT_TYPES = [
  "fact", "preference", "decision", "strategy", "process", "person", "resource", "insight", "question", "idea",
] as const;

export type ConsoleFailure = {ok: false; status: 400 | 403; code: string; error: string};

export function expectedIssuer(supabaseUrl: string): string {
  const base = supabaseUrl.trim().replace(/\/+$/, "");
  if (!base.startsWith("https://") || base.includes(" ") || base.includes("?")) {
    throw new Error("Invalid Supabase URL");
  }
  return `${base}/auth/v1`;
}

export function audienceIsAuthenticated(aud: unknown): boolean {
  if (aud === "authenticated") return true;
  return Array.isArray(aud) && aud.length === 1 && aud[0] === "authenticated";
}

export function assessOwnerSession(claims: unknown, nowMs: number, issuer: string, userId: string): boolean {
  if (!claims || typeof claims !== "object") return false;
  const record = claims as Record<string, unknown>;
  if (record.sub !== userId || record.role !== "authenticated" || record.iss !== issuer) return false;
  if (!audienceIsAuthenticated(record.aud)) return false;
  return typeof record.exp === "number" && Number.isFinite(record.exp) && record.exp * 1000 > nowMs;
}

export function corsHeaders(origin: string | null): Record<string, string> | null {
  if (origin !== PAGES_ORIGIN) return null;
  return {
    "access-control-allow-origin": PAGES_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, apikey",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function consoleRoute(pathname: string): string {
  const marker = "/brain-console";
  const index = pathname.lastIndexOf(marker);
  const rest = index >= 0 ? pathname.slice(index + marker.length) : pathname;
  if (rest === "" || rest === "/") return "/";
  const normalized = rest.startsWith("/") ? rest : `/${rest}`;
  if (normalized.length > 200 || normalized.includes("..") || normalized.includes("//")) return "/";
  return normalized;
}

export function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

export type DecisionInput = {id: string; decision: "approve" | "reject"; kind: "memory" | "space"};

export function validateDecision(body: Record<string, unknown>): {ok: true; value: DecisionInput} | ConsoleFailure {
  const id = parseUuid(body.id);
  if (!id) return {ok: false, status: 400, code: "id", error: "Invalid ID"};
  if (body.decision !== "approve" && body.decision !== "reject") {
    return {ok: false, status: 400, code: "decision", error: "Invalid decision"};
  }
  if (body.kind !== "memory" && body.kind !== "space") {
    return {ok: false, status: 400, code: "kind", error: "Invalid proposal type"};
  }
  return {ok: true, value: {id, decision: body.decision, kind: body.kind}};
}

/** Some legacy rows store proposal JSON as nested JSON strings (jsonb string scalars). */
export function coerceProposedContent(content: unknown): Record<string, unknown> | null {
  let value = content;
  for (let depth = 0; depth < 4; depth += 1) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

export function validateMemoryContent(proposedType: unknown, content: unknown): {ok: true; title: string; body: string; itemType?: string} | ConsoleFailure {
  const record = coerceProposedContent(content);
  if (!record) {
    return {ok: false, status: 400, code: "content", error: "Invalid memory content"};
  }
  if (typeof record.title !== "string" || typeof record.body !== "string") {
    return {ok: false, status: 400, code: "content", error: "Invalid memory content"};
  }
  const title = record.title.trim();
  const body = record.body.trim();
  if (!title || !body || title.length > 160 || body.length > 10000) {
    return {ok: false, status: 400, code: "content", error: "Invalid memory content"};
  }
  if (proposedType === "revise") return {ok: true, title, body};
  if (proposedType !== "create") {
    return {ok: false, status: 400, code: "unsupported", error: "Unsupported operation requires manual review"};
  }
  if (typeof record.item_type !== "string" || !(MEMORY_CONTENT_TYPES as readonly string[]).includes(record.item_type)) {
    return {ok: false, status: 400, code: "type", error: "Missing type/scope/provenance"};
  }
  return {ok: true, title, body, itemType: record.item_type};
}

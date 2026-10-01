/**
 * How the browser talks to the api. Shared so it can be tested in node: the
 * server refuses any POST to /api/* that is not application/json (CSRF
 * defence in depth), so a write with no payload still has to send `{}`.
 * Close went out bare for weeks and was refused with 415 (#19).
 */

export interface ApiRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export function apiRequest(body?: unknown, method = "POST"): ApiRequest {
  if (method === "GET" || method === "HEAD") return { method, headers: {} };
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

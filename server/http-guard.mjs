/**
 * Request guard for the local API (bound to 127.0.0.1).
 *
 * - Host must be this server (blocks DNS-rebinding: a hostile page cannot reach us under its own hostname).
 * - Writes must come from this server's own origin (blocks cross-site form posts / `text/plain` "simple" requests).
 * - Writes with a body must be `application/json` (a cross-site simple request cannot set that without a preflight).
 *
 * Wire it in with two lines, before routing:
 *   if (guardRequest(request, response)) return;
 */
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const header = (request, name) => {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

export function allowedHostsFor(request, extra = []) {
  const port = request.socket?.localPort;
  const bare = ["127.0.0.1", "localhost", "[::1]"];
  return [...(port ? bare.map((host) => `${host}:${port}`) : []), ...extra];
}

export const mediaType = (value) => String(value || "").split(";")[0].trim().toLowerCase();

/** Returns null when the request may proceed, otherwise `{ status, code, message }`. */
export function evaluateRequest(request, { allowedHosts } = {}) {
  const hosts = allowedHosts ?? allowedHostsFor(request);
  const method = String(request.method || "GET").toUpperCase();
  const host = String(header(request, "host") || "").toLowerCase();

  if (!hosts.includes(host)) {
    return { status: 403, code: "HOST_NOT_ALLOWED", message: "只接受通过 127.0.0.1 / localhost 访问本地工作台" };
  }
  if (SAFE_METHODS.has(method)) return null;

  const origin = header(request, "origin");
  if (origin !== undefined && !hosts.some((allowed) => origin.toLowerCase() === `http://${allowed}`)) {
    return { status: 403, code: "ORIGIN_NOT_ALLOWED", message: "拒绝来自其他网站的写入请求" };
  }
  const site = header(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { status: 403, code: "CROSS_SITE_BLOCKED", message: "拒绝跨站写入请求" };
  }

  const hasBody = BODY_METHODS.has(method)
    || (method === "DELETE" && (Number(header(request, "content-length")) > 0 || header(request, "transfer-encoding") !== undefined));
  if (hasBody && mediaType(header(request, "content-type")) !== "application/json") {
    return { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "请求必须使用 Content-Type: application/json" };
  }
  return null;
}

/** Sends the JSON error and returns true when the request was blocked. */
export function guardRequest(request, response, options) {
  const blocked = evaluateRequest(request, options);
  if (!blocked) return false;
  response.writeHead(blocked.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The request body was not read, so do not reuse this connection.
    Connection: "close",
  });
  response.end(JSON.stringify({ error: blocked.message, code: blocked.code }));
  return true;
}

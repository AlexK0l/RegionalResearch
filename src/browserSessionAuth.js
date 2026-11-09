import crypto from "node:crypto";

// Browser login is opt-in; legacy bearer-token clients and local deployments
// continue working when WEB_LOGIN_PASSWORD_HASH is unset.
export const SESSION_COOKIE_NAME = "__Host-regionalresearch_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const PASSWORD_HASH_FORMAT = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/i;
const SESSION_FORMAT = /^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/;

export function createBrowserSessionAuth({passwordHash = "", apiToken = "", now = Date.now} = {}) {
  const enabled = Boolean(String(passwordHash).trim());
  if (enabled && !apiToken) {
    throw new Error("WEB_LOGIN_PASSWORD_HASH requires API_ACCESS_TOKEN");
  }
  const match = enabled ? PASSWORD_HASH_FORMAT.exec(String(passwordHash).trim()) : null;
  if (enabled && !match) {
    throw new Error("WEB_LOGIN_PASSWORD_HASH must be scrypt:<32 hex salt>:<128 hex hash>");
  }
  const salt = match ? Buffer.from(match[1], "hex") : null;
  const storedHash = match ? Buffer.from(match[2], "hex") : null;
  const key = Buffer.from(String(apiToken));

  function passwordMatches(password) {
    if (!enabled || typeof password !== "string" || !password || password.length > 1024) return false;
    const supplied = crypto.scryptSync(password, salt, storedHash.length);
    return crypto.timingSafeEqual(storedHash, supplied);
  }

  function bearerMatches(token) {
    if (!apiToken || typeof token !== "string" || !token) return false;
    const supplied = Buffer.from(token);
    return supplied.length === key.length && crypto.timingSafeEqual(supplied, key);
  }

  function signature(payload) {
    return crypto.createHmac("sha256", key)
      .update("regionalresearch-browser-session-v1:" + payload)
      .digest("hex");
  }

  function makeCookie() {
    if (!enabled) throw new Error("Browser session auth is disabled");
    const payload = String(Math.trunc(now())) + "." + crypto.randomBytes(16).toString("hex");
    const value = payload + "." + signature(payload);
    return SESSION_COOKIE_NAME + "=" + value +
      "; Max-Age=" + SESSION_MAX_AGE_SECONDS + "; Path=/; Secure; HttpOnly; SameSite=Strict";
  }

  function clearCookie() {
    return SESSION_COOKIE_NAME + "=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict";
  }

  function validCookieHeader(rawHeader) {
    if (!enabled || typeof rawHeader !== "string") return false;
    const part = rawHeader.split(";").map(s => s.trim())
      .find(s => s.startsWith(SESSION_COOKIE_NAME + "="));
    const value = part ? part.slice(SESSION_COOKIE_NAME.length + 1) : "";
    const match = SESSION_FORMAT.exec(value);
    if (!match) return false;
    const issuedAt = Number(match[1]);
    const currentTime = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt > currentTime ||
        currentTime - issuedAt >= MAX_SESSION_AGE_MS) return false;
    const payload = match[1] + "." + match[2];
    const supplied = Buffer.from(match[3], "hex");
    const expected = Buffer.from(signature(payload), "hex");
    return crypto.timingSafeEqual(supplied, expected);
  }

  return {enabled, passwordMatches, bearerMatches, makeCookie, clearCookie, validCookieHeader};
}

export function isSameRequestOrigin(req) {
  const origin = String(req.get("origin") || "");
  const host = String(req.get("host") || "").toLowerCase();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {createBrowserSessionAuth, SESSION_COOKIE_NAME, isSameRequestOrigin} from "../src/browserSessionAuth.js";

const salt = crypto.randomBytes(16);
const hash = "scrypt:" + salt.toString("hex") + ":" +
  crypto.scryptSync("correct horse battery staple", salt, 64).toString("hex");

test("browser password and legacy bearer token are checked separately", () => {
  const auth = createBrowserSessionAuth({passwordHash:hash, apiToken:"a".repeat(64)});
  assert.equal(auth.passwordMatches("correct horse battery staple"), true);
  assert.equal(auth.passwordMatches("incorrect"), false);
  assert.equal(auth.bearerMatches("a".repeat(64)), true);
  assert.equal(auth.bearerMatches("bad"), false);
});

test("30-day signed cookie has Secure, HttpOnly, SameSite=Strict and rejects tampering", () => {
  let now = 1780000000000;
  const auth = createBrowserSessionAuth({passwordHash:hash, apiToken:"a".repeat(64), now:() => now});
  const cookie = auth.makeCookie();
  assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
  assert.ok(cookie.startsWith(SESSION_COOKIE_NAME + "="));
  assert.equal(auth.validCookieHeader(cookie), true);
  assert.equal(auth.validCookieHeader("other=x; " + cookie), true);
  const value = cookie.split(";")[0];
  const tampered = value.slice(0,-1) + (value.endsWith("0") ? "1" : "0");
  assert.equal(auth.validCookieHeader(tampered), false);
  now += 29 * 24 * 3600 * 1000;
  assert.equal(auth.validCookieHeader(cookie), true);
  now += 24 * 3600 * 1000;
  assert.equal(auth.validCookieHeader(cookie), false);
  assert.match(auth.clearCookie(), /Max-Age=0/);
});

test("invalid login settings fail closed and legacy mode remains optional", () => {
  assert.throws(() => createBrowserSessionAuth({passwordHash:"invalid", apiToken:"key"}), /WEB_LOGIN_PASSWORD_HASH/);
  assert.throws(() => createBrowserSessionAuth({passwordHash:hash}), /API_ACCESS_TOKEN/);
  assert.equal(createBrowserSessionAuth({}).enabled, false);
});

test("browser cookie is invalid after rotating API_ACCESS_TOKEN", () => {
  const a = createBrowserSessionAuth({passwordHash:hash, apiToken:"a".repeat(64)});
  const b = createBrowserSessionAuth({passwordHash:hash, apiToken:"b".repeat(64)});
  assert.equal(b.validCookieHeader(a.makeCookie()), false);
});

test("same-origin check rejects other hosts and missing Origin for cookie POSTs", () => {
  const request = (origin) => ({get: name => ({
    origin,
    host:"89-40-7-126.sslip.io"
  }[name])});
  assert.equal(isSameRequestOrigin(request("https://89-40-7-126.sslip.io")), true);
  assert.equal(isSameRequestOrigin(request("https://evil.sslip.io")), false);
  assert.equal(isSameRequestOrigin(request("")), false);
  assert.equal(isSameRequestOrigin(request("null")), false);
});

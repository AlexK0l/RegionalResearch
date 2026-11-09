// Interactive Saby login: credentials come ONLY from server-side .env.
// Never submit credentials on redirects or third-party domains.
// No attempts to automate SMS/2FA/captcha. Persistent Playwright profile keeps
// successful sessions across research jobs, so the password is not re-entered.
const PROFILE_URL = "https://profile.saby.ru/page/company-list-prof";
const AUTH_URL = "https://online.saby.ru/auth/";

export class SabyAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "SabyAuthError";
  }
}

export function sabyCredentials(env = process.env) {
  const login = String(env.SABY_LOGIN || "").trim();
  const password = String(env.SABY_PASSWORD || "");
  if (Boolean(login) !== Boolean(password)) {
    throw new SabyAuthError("SABY_LOGIN и SABY_PASSWORD должны быть заполнены вместе");
  }
  return {login, password, configured:Boolean(login && password)};
}

function safeUrl(value, host, prefix) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && u.hostname === host &&
      (!prefix || u.pathname === prefix || u.pathname.startsWith(prefix + "/"));
  } catch { return false; }
}

export function trustedSabyLoginUrl(url) {
  return safeUrl(url, "online.saby.ru", "/auth");
}
function trustedProfileUrl(url) {
  return safeUrl(url, "profile.saby.ru", "");
}

async function firstVisible(locator) {
  if (!locator) return null;
  let n = 0;
  try { n = Math.min(10, await locator.count()); }
  catch { return null; }
  for (let i = 0; i < n; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function profileSearchPresent(page) {
  if (!trustedProfileUrl(page.url())) return false;
  return Boolean(await firstVisible(page.locator(
    'input[type="search"],input[placeholder*="Поиск"],input[placeholder*="поиск"]'
  )));
}

async function waitProfileSearch(page, timeoutMs) {
  const limit = Date.now() + timeoutMs;
  do {
    if (await profileSearchPresent(page)) return true;
    await new Promise(resolve => setTimeout(resolve, 350));
  } while (Date.now() < limit);
  return false;
}

async function openTrustedPage(page, url, timeoutMs) {
  try {
    await page.goto(url, {waitUntil:"domcontentloaded", timeout:timeoutMs});
  } catch {
    // Avoid including Playwright error text: it may contain site-supplied URLs.
    throw new SabyAuthError("Saby: не удалось открыть страницу авторизации");
  }
}

async function loginInput(page) {
  const select = await firstVisible(page.locator(
    'input[autocomplete="username"],input[placeholder*="логин" i],' +
    'input[placeholder*="телефон" i],input[name*="login" i],input[name*="username" i]'
  ));
  if (select) return select;
  // Some Saby layouts render a labelled input without a placeholder.
  const named = await firstVisible(page.getByRole("textbox", {name:/телефон|логин/i}));
  if (named) return named;
  // Fallback only when there is exactly one visible non-password text input.
  const fallback = page.locator('input[type="text"],input[type="tel"],input:not([type])');
  const n = Math.min(await fallback.count().catch(() => 0), 10);
  const visible = [];
  for(let i=0;i<n;i++) {
    const item = fallback.nth(i);
    if(await item.isVisible().catch(() => false)) visible.push(item);
  }
  return visible.length === 1 ? visible[0] : null;
}

async function passwordInput(page) {
  return firstVisible(page.locator('input[type="password"],input[autocomplete="current-password"]'));
}

async function verificationPrompt(page) {
  const code = await firstVisible(page.locator(
    'input[autocomplete="one-time-code"],input[placeholder*="код" i]'
  ));
  if (code) return true;
  const marker = page.getByText(/подтвердите вход|код подтверждения|код из SMS|вход по коду|CAPTCHA|капча/i);
  return Boolean(await firstVisible(marker));
}

async function requireManual(allowManual, message) {
  if (allowManual) return {status:"manual_required", message};
  throw new SabyAuthError(message + ". Запустите npm run saby:smoke -- --login");
}

/**
 * Run once per Playwright session, before processing any companies.
 * Existing sessions are preferred. Credentials are used only on the
 * canonical first-party HTTPS sign-in page and never echoed to logs.
 */
export async function authenticateSaby(page, settings, {allowManual = false} = {}) {
  const {login, password, configured} = sabyCredentials(settings);
  if (!configured) return {status:"not_configured"};
  const timeoutMs = Math.max(15000, Math.min(90000, Number(settings.timeoutMs) || 45000));

  await openTrustedPage(page, PROFILE_URL, timeoutMs);
  if (await waitProfileSearch(page, 4500)) return {status:"existing_session"};

  await openTrustedPage(page, AUTH_URL, timeoutMs);
  // A still-valid cookie may redirect directly to the authenticated UI.
  if (!trustedSabyLoginUrl(page.url())) {
    if (trustedProfileUrl(page.url()) && await waitProfileSearch(page, 3500)) {
      return {status:"existing_session"};
    }
    return requireManual(allowManual, "Saby открыл нестандартную страницу входа");
  }

  const user = await loginInput(page);
  if (!user) return requireManual(allowManual, "Не найдено поле логина Saby");
  try { await user.fill(login); }
  catch { throw new SabyAuthError("Не удалось ввести логин Saby"); }

  let pwd = await passwordInput(page);
  if (!pwd) {
    try { await user.press("Enter"); }
    catch { throw new SabyAuthError("Не удалось перейти к вводу пароля Saby"); }
    const until = Date.now() + 9000;
    while(Date.now() < until && !pwd) {
      if (!trustedSabyLoginUrl(page.url())) break;
      pwd = await passwordInput(page);
      if (!pwd) await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  // Recheck the URL immediately before submitting the secret.
  if (!trustedSabyLoginUrl(page.url())) {
    return requireManual(allowManual, "Saby изменил страницу входа");
  }
  if (!pwd) return requireManual(allowManual, "Не найдено поле пароля Saby");
  try {
    await pwd.fill(password);
    await pwd.press("Enter");
  } catch {
    throw new SabyAuthError("Не удалось отправить форму входа Saby");
  }

  const until = Date.now() + 11000;
  while(Date.now() < until) {
    if (await profileSearchPresent(page)) return {status:"authenticated"};
    if (trustedSabyLoginUrl(page.url()) && await verificationPrompt(page)) {
      return requireManual(allowManual, "Saby требует дополнительного подтверждения");
    }
    if (!trustedSabyLoginUrl(page.url())) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  // Once login is complete, Saby may land in the company cabinet rather than
  // in profile.saby.ru. Confirm access by opening the actual research page.
  if (!trustedSabyLoginUrl(page.url()) &&
      !safeUrl(page.url(),"online.saby.ru","") &&
      !trustedProfileUrl(page.url())) {
    return requireManual(allowManual, "Не удалось проверить авторизацию Saby");
  }
  if (trustedSabyLoginUrl(page.url())) {
    return requireManual(allowManual, "Saby не подтвердил вход");
  }
  await openTrustedPage(page, PROFILE_URL, timeoutMs);
  if (await waitProfileSearch(page, 5500)) return {status:"authenticated"};
  return requireManual(allowManual, "Авторизация Saby не подтверждена");
}

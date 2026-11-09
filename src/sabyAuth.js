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
  // The company profile redirects to the legacy, first-party SSO host on
  // some deployments. Trust *only* these exact HTTPS hosts and auth paths.
  return safeUrl(url, "online.saby.ru", "/auth") ||
    safeUrl(url, "sso.saby.ru", "/auth-online") ||
    safeUrl(url, "sso.sbis.ru", "/auth-online");
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
    'input[type="search"],input[role="searchbox"],[role="searchbox"],' +
    'input[placeholder*="Поиск" i],input[placeholder*="Search" i],' +
    'input[aria-label*="Поиск" i],input[aria-label*="Search" i]'
  )));
}

// A successful Saby Profile session is sometimes shown as a company-list
// application without a conventional input[type=search] (responsive/new DOM).
// Verify the actual company-list URL and a substantive app, not only a field.
export async function sabyProfileSessionReady(page) {
  if (!trustedProfileUrl(page.url())) return false;
  if (await profileSearchPresent(page)) return true;
  if (typeof page.evaluate !== "function") return false;
  try {
    return Boolean(await page.evaluate(() => {
      if (location.protocol !== "https:" ||
          location.hostname !== "profile.saby.ru" ||
          !location.pathname.startsWith("/page/company-list-prof")) return false;
      const body = document.body;
      if (!body) return false;
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== "hidden" && style.display !== "none";
      };
      const loginFields = [
        ...document.querySelectorAll(
          'input[type="password"],input[autocomplete="username"],' +
          'input[autocomplete="one-time-code"],' +
          'input[placeholder*="Phone or login" i],input[placeholder*="Телефон или логин" i]'
        )
      ].some(visible);
      if (loginFields) return false;
      const text = String(body.innerText || "").trim().slice(0,10000);
      if (text.length < 50) return false;
      const hasCompanyContext = /компан|организац|company|companies|профил|сведения|деятельност/i.test(text);
      const hasApp = Boolean(document.querySelector(
        'main,article,[role="main"],[class*="company"],[class*="Company"],' +
        '[class*="search"],[class*="Search"],[data-qa*="company"],[data-testid*="company"]'
      ));
      return hasCompanyContext && hasApp;
    }));
  } catch {
    return false;
  }
}

async function waitProfileSearch(page, timeoutMs) {
  const limit = Date.now() + timeoutMs;
  do {
    if (await sabyProfileSessionReady(page)) return true;
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
    'input[placeholder*="телефон" i],input[placeholder*="login" i],' +
    'input[placeholder*="phone" i],input[aria-label*="логин" i],' +
    'input[aria-label*="login" i],input[name*="login" i],' +
    'input[name*="username" i]'
  ));
  if (select) return select;
  // Some Saby layouts render a labelled input without a placeholder.
  const named = await firstVisible(page.getByRole("textbox", {name:/телефон|логин|phone|login/i}));
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

// Some Saby sign-in pages use a small arrow alongside "Phone or login"
// instead of a submit button. Try exactly one visible control in the input
// wrapper; never click navigation tabs or an arbitrary coordinate.
async function advanceLogin(page, user) {
  if (typeof user.locator === "function") {
    let parent = user;
    for (let depth=0; depth<3; depth++) {
      parent = parent.locator("xpath=..");
      if (!parent || typeof parent.locator !== "function") break;
      const controls = parent.locator('button,[role="button"],input[type="submit"]');
      let count = 0;
      try { count = await controls.count(); } catch { break; }
      if (count !== 1) continue;
      const control = controls.nth(0);
      if (!await control.isVisible().catch(()=>false)) continue;
      let suitable = true;
      try {
        suitable = await parent.evaluate(el=>{
          const r=el.getBoundingClientRect();
          return r.width>0 && r.width<=800 && r.height>0 && r.height<=200;
        });
      } catch { suitable = false; }
      if (!suitable) continue;
      try {
        await control.click({timeout:4000});
        return "arrow_button";
      } catch { break; }
    }
  }
  // Standard keyboard submit is still needed for older Saby layouts.
  await user.press("Enter");
  return "enter";
}

async function verificationPrompt(page) {
  const code = await firstVisible(page.locator(
    'input[autocomplete="one-time-code"],input[placeholder*="код" i]'
  ));
  if (code) return true;
  const marker = page.getByText(/подтвердите вход|код подтверждения|код из SMS|verification code|enter the code|CAPTCHA|капча/i);
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
export async function authenticateSaby(page, settings, {allowManual = false, onPhase = null} = {}) {
  // Only phase identifiers reach logs; never usernames, passwords or URLs.
  const phase = label => { if (typeof onPhase === "function") onPhase(label); };
  phase("start");
  const {login, password, configured} = sabyCredentials({
    SABY_LOGIN: settings.login ?? settings.SABY_LOGIN,
    SABY_PASSWORD: settings.password ?? settings.SABY_PASSWORD
  });
  if (!configured) return {status:"not_configured"};
  const timeoutMs = Math.max(15000, Math.min(90000, Number(settings.timeoutMs) || 45000));

  await openTrustedPage(page, PROFILE_URL, timeoutMs);
  if (await waitProfileSearch(page, 4500)) {
    phase("existing_session");
    return {status:"existing_session"};
  }

  // Keep an already established, first-party SSO redirect and its
  // `ret=profile.saby.ru/...` target. Navigating to a different login URL
  // would throw away the return URL and can break an otherwise valid flow.
  if (!trustedSabyLoginUrl(page.url())) {
    await openTrustedPage(page, AUTH_URL, timeoutMs);
  }
  // Only the canonical Saby/SBIS sign-in paths are allowed.
  if (!trustedSabyLoginUrl(page.url())) {
    if (trustedProfileUrl(page.url()) && await waitProfileSearch(page, 3500)) {
      return {status:"existing_session"};
    }
    return requireManual(allowManual, "Saby открыл нестандартную страницу входа");
  }

  // The first screen may contain only "Телефон или логин" / "Phone or login".
  // Other Saby accounts show both fields at once. Both layouts are supported.
  // The login form is hydrated asynchronously after DOMContentLoaded.
  // Do not declare the field missing just because the SPA is still loading.
  let user = null;
  const formDeadline=Date.now()+12000;
  while(Date.now()<formDeadline && trustedSabyLoginUrl(page.url()) && !user) {
    user=await loginInput(page);
    if(!user) await new Promise(resolve=>setTimeout(resolve,300));
  }
  if (!user) return requireManual(allowManual, "Не найдено поле логина Saby");
  phase("login_field_found");
  if (!trustedSabyLoginUrl(page.url())) {
    return requireManual(allowManual, "Изменился адрес формы входа Saby");
  }
  try { await user.fill(login); }
  catch { throw new SabyAuthError("Не удалось ввести логин Saby"); }
  phase("login_filled");

  let pwd = await passwordInput(page);
  if (!pwd) {
    // Some UIs reveal the password field in response to input/change.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !pwd && trustedSabyLoginUrl(page.url())) {
      await new Promise(resolve=>setTimeout(resolve, 200));
      pwd = await passwordInput(page);
    }
  }
  if (!pwd) {
    if (await verificationPrompt(page)) {
      return requireManual(allowManual, "Saby запросил дополнительное подтверждение вместо пароля");
    }
    if (!trustedSabyLoginUrl(page.url())) {
      return requireManual(allowManual, "Изменился адрес формы входа Saby");
    }
    phase("login_next");
    // Advance once using the input's adjacent arrow or Enter.
    try {
      const method=await advanceLogin(page,user);
      phase("login_advanced_"+method);
    } catch { throw new SabyAuthError("Не удалось перейти к вводу пароля Saby"); }
    const until = Date.now() + 12000;
    while(Date.now() < until && !pwd) {
      if (!trustedSabyLoginUrl(page.url())) break;
      pwd = await passwordInput(page);
      if (!pwd) await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  // Recheck the URL immediately before submitting the secret.
  if (!trustedSabyLoginUrl(page.url())) {
    return requireManual(allowManual, "Saby изменил страницу входа");
  }
  if (!pwd) return requireManual(allowManual, "Saby не показал поле пароля после ввода логина");
  phase("password_field_found");
  try {
    await pwd.fill(password);
    phase("password_filled");
    // Submit only once. Repeated retries can lock a Saby account.
    await pwd.press("Enter");
    phase("submitted");
  } catch {
    throw new SabyAuthError("Не удалось отправить форму входа Saby");
  }

  const until = Date.now() + 16000;
  while(Date.now() < until) {
    if (await sabyProfileSessionReady(page)) {
      phase("authenticated");
      return {status:"authenticated"};
    }
    if (trustedSabyLoginUrl(page.url()) && await verificationPrompt(page)) {
      phase("manual_confirmation");
      return requireManual(allowManual, "Saby требует дополнительного подтверждения");
    }
    if (!trustedSabyLoginUrl(page.url())) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  // Once login is complete, Saby may land in the company cabinet rather than
  // in profile.saby.ru. Confirm access by opening the actual research page.
  if (!trustedSabyLoginUrl(page.url()) &&
      !safeUrl(page.url(),"online.saby.ru","") &&
      !safeUrl(page.url(),"sso.saby.ru","") &&
      !safeUrl(page.url(),"sso.sbis.ru","") &&
      !trustedProfileUrl(page.url())) {
    return requireManual(allowManual, "Не удалось проверить авторизацию Saby");
  }
  if (trustedSabyLoginUrl(page.url())) {
    return requireManual(allowManual, "Saby не подтвердил вход");
  }
  await openTrustedPage(page, PROFILE_URL, timeoutMs);
  if (await waitProfileSearch(page, 8000)) {
    phase("authenticated");
    return {status:"authenticated"};
  }
  return requireManual(allowManual, "Авторизация Saby не подтверждена");
}


// Observe the browser while the human completes 2FA or while Saby finishes a
// slow post-login redirect. No console input or extra credential submissions.
// Never navigate while the login/challenge page is visible: doing so would
// interrupt a human verification. Only probe the profile after a successful
// transition to a known non-authenticated-interface domain.
export async function waitForSabySession(page, {
  timeoutMs = 120000,
  pollMs = 750,
  onPhase = null
} = {}) {
  const cap = Math.max(100, Math.min(Number(timeoutMs) || 120000, 300000));
  const interval = Math.max(20, Math.min(Number(pollMs) || 750, 3000));
  const phase = label => { if (typeof onPhase === "function") onPhase(label); };
  const until = Date.now() + cap;
  let lastProbe = 0;
  while (Date.now() < until) {
    if (typeof page.isClosed === "function" && page.isClosed()) {
      return {status:"browser_closed"};
    }
    try {
      if (await sabyProfileSessionReady(page)) {
        phase("authenticated");
        return {status:"authenticated"};
      }
      const current = page.url();
      // Non-login Saby destination may mean a successful authentication.
      // Verify by opening the actual target. Do not disrupt an SSO/MFA page.
      const knownCabinet = (
        safeUrl(current, "online.saby.ru", "") ||
        safeUrl(current, "sso.sbis.ru", "") ||
        safeUrl(current, "sso.saby.ru", "")
      ) && !trustedSabyLoginUrl(current);
      if (knownCabinet && Date.now() - lastProbe > 7000) {
        lastProbe = Date.now();
        await openTrustedPage(page, PROFILE_URL, Math.min(15000,cap));
        if (await waitProfileSearch(page, 3500)) {
          phase("authenticated");
          return {status:"authenticated"};
        }
      }
    } catch {
      // Browser navigation may be underway; retry until the bounded deadline.
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  phase("verification_timeout");
  return {status:"timeout"};
}

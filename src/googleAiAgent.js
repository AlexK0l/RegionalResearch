import { chromium } from "playwright";

const COMPUTER_MODEL = process.env.COMPUTER_MODEL || "gpt-5.6-sol";
const MAX_TURNS = Number(process.env.GOOGLE_AI_MAX_TURNS || 18);

export async function launchResearchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });
}

function normalizeKey(key) {
  const map = {
    CTRL: "Control",
    CMD: "Meta",
    COMMAND: "Meta",
    ALT: "Alt",
    SHIFT: "Shift",
    ENTER: "Enter",
    RETURN: "Enter",
    ESC: "Escape",
    ESCAPE: "Escape",
    BACKSPACE: "Backspace",
    TAB: "Tab",
    SPACE: "Space",
    ARROWDOWN: "ArrowDown",
    ARROWUP: "ArrowUp",
    ARROWLEFT: "ArrowLeft",
    ARROWRIGHT: "ArrowRight"
  };
  return map[String(key).toUpperCase()] || key;
}

async function executeActions(page, actions = []) {
  for (const action of actions) {
    switch (action.type) {
      case "click":
        await page.mouse.click(action.x, action.y, {
          button: action.button || "left"
        });
        break;
      case "double_click":
        await page.mouse.click(action.x, action.y, {
          button: action.button || "left",
          clickCount: 2
        });
        break;
      case "move":
        await page.mouse.move(action.x, action.y);
        break;
      case "drag": {
        const path = action.path || [];
        if (!path.length) break;
        await page.mouse.move(path[0].x, path[0].y);
        await page.mouse.down();
        for (const point of path.slice(1)) {
          await page.mouse.move(point.x, point.y, { steps: 3 });
        }
        await page.mouse.up();
        break;
      }
      case "scroll":
        await page.mouse.wheel(
          action.scroll_x ?? action.x ?? 0,
          action.scroll_y ?? action.y ?? 0
        );
        break;
      case "keypress": {
        const keys = (action.keys || []).map(normalizeKey);
        if (keys.length) await page.keyboard.press(keys.join("+"));
        break;
      }
      case "type":
        await page.keyboard.insertText(action.text || "");
        break;
      case "wait":
        await page.waitForTimeout(Math.min(Number(action.ms ?? (action.duration ? action.duration * 1000 : 1200)), 5000));
        break;
      case "screenshot":
        break;
      default:
        throw new Error(`Unsupported computer action: ${action.type}`);
    }
    await page.waitForTimeout(120);
  }
}

async function hasGoogleChallenge(page) {
  const title = (await page.title().catch(() => "")).toLowerCase();
  const body = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")).toLowerCase();
  return (
    title.includes("unusual traffic") ||
    body.includes("our systems have detected unusual traffic") ||
    body.includes("подтвердите, что вы не робот") ||
    body.includes("captcha") ||
    body.includes("recaptcha")
  );
}

function parseJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Computer agent did not return JSON");
  }
}

function agentPrompt(row, region) {
  const org = row["Организация"] || "";
  const inn = row["ИНН"] || "";
  const city = row["Город/район"] || "";
  const currentPhone = row["Телефон"] || "";

  return `You operate a virtual Chromium browser. It is already open on Google.

TASK
Process this exact company row:
Organization: ${org}
INN: ${inn || "not known"}
Region: ${region}
City/district: ${city || "not known"}
Existing phone cell: ${currentPhone || "empty"}

MANDATORY PROCEDURE
1. Use the visible Google interface and switch to "Режим ИИ" / AI Mode through the page UI.
2. First query exactly: "${org} ${inn} контакты".
3. Wait for the complete answer and extract ALL phone numbers that explicitly belong to this exact legal entity.
4. Verify the company primarily by INN. Never use phones of namesakes, related companies, parent/subsidiary companies, neighboring organizations, marketplaces, directories, or service providers unless the phone is explicitly tied to this INN.
5. If the first query yields no confirmed phone, run a second query exactly: "${org} ${inn} телефон".
6. Never invent, complete, extrapolate, or guess digits.
7. Preserve existing phones conceptually: only report newly confirmed phone candidates.
8. For every phone, include the department/person when the answer clearly identifies it. Format each candidate as:
   7XXXXXXXXXX (department/person)
   If no department/person is known, return only 7XXXXXXXXXX.
9. Normalize Russian phones to 7XXXXXXXXXX before returning them. Multiple phones must be separated with "; ".
10. Do not return emails, websites, comments, or sources in the phone field.
11. Do not sign in, bypass CAPTCHA, bot checks, access controls, or paywalls. If blocked or AI Mode is unavailable, return "unavailable".
12. Stay within Google / Google AI Mode.

Return ONLY valid JSON:
{
  "status": "ok" | "unavailable" | "not_found",
  "phone": "",
  "leader": "",
  "official_site": "",
  "note": ""
}

"phone" must contain only confirmed NEW phone candidates for this exact INN, separated by "; ".`;
}

function phoneVerificationPrompt({ row, region, phone }) {
  const org = row["Организация"] || "";
  const inn = row["ИНН"] || "";
  return `You operate a virtual Chromium browser on Google.

VERIFY OWNERSHIP OF THIS PHONE
Company: ${org}
INN: ${inn || "not known"}
Region: ${region}
Phone: ${phone}

Run a separate Google AI Mode query exactly:
"${phone} ${inn}"

Confirm the phone ONLY if the answer or clearly visible supporting information ties this exact phone to this exact legal entity / INN.
Do not accept a namesake, related company, branch of another legal entity, marketplace, directory owner, or neighboring organization.
Do not infer ownership from similarity.
If not clearly confirmed, return false.
Do not bypass CAPTCHA or sign-in.

Return ONLY valid JSON:
{
  "confirmed": true | false,
  "phone": "${phone}",
  "note": ""
}`;
}

async function runComputerJson({ client, page, prompt, unavailableResult }) {
  let response = await client.responses.create({
    model: COMPUTER_MODEL,
    tools: [{ type: "computer" }],
    reasoning: { effort: "low" },
    input: prompt
  });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const call = (response.output || []).find((item) => item.type === "computer_call");
    if (!call) return parseJson(response.output_text || "");

    await executeActions(page, call.actions || []);

    const host = new URL(page.url()).hostname;
    if (!/(^|\\.)google\\./i.test(host)) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    }

    if (await hasGoogleChallenge(page)) return unavailableResult;

    const screenshot = await page.screenshot({ type: "png" });
    response = await client.responses.create({
      model: COMPUTER_MODEL,
      tools: [{ type: "computer" }],
      previous_response_id: response.id,
      input: [
        {
          type: "computer_call_output",
          call_id: call.call_id,
          output: {
            type: "computer_screenshot",
            image_url: `data:image/png;base64,${screenshot.toString("base64")}`,
            detail: "original"
          }
        }
      ]
    });
  }

  return unavailableResult;
}

export async function verifyPhoneForCompanyWithGoogleAI({ client, browser, row, region, phone, isCancelled }) {
  if (isCancelled?.()) throw new Error("JOB_CANCELLED");

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    await page.goto(
      "https://www.google.com/search?q=" + encodeURIComponent(`${phone} ${row["ИНН"] || ""}`),
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await page.waitForTimeout(1200);

    if (await hasGoogleChallenge(page)) {
      return { confirmed: false, phone, note: "Google challenge/CAPTCHA" };
    }

    return await runComputerJson({
      client,
      page,
      prompt: phoneVerificationPrompt({ row, region, phone }),
      unavailableResult: { confirmed: false, phone, note: "verification unavailable" }
    });
  } finally {
    await context.close().catch(() => {});
  }
}

export async function enrichCompanyWithGoogleAI({ client, browser, row, region, isCancelled }) {
  if (isCancelled?.()) throw new Error("JOB_CANCELLED");

  const queryParts = [
    row["Организация"],
    row["ИНН"] ? `ИНН ${row["ИНН"]}` : "",
    "контакты телефон директор"
  ].filter(Boolean);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();

  try {
    await page.goto(
      "https://www.google.com/search?q=" + encodeURIComponent(queryParts.join(" ")),
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await page.waitForTimeout(1200);

    if (await hasGoogleChallenge(page)) {
      return { status: "unavailable", phone: "", leader: "", official_site: "", note: "Google challenge/CAPTCHA" };
    }

    return await runComputerJson({
      client,
      page,
      prompt: agentPrompt(row, region),
      unavailableResult: {
        status: "unavailable",
        phone: "",
        leader: "",
        official_site: "",
        note: "Computer-use turn limit reached or unavailable"
      }
    });
  } finally {
    await context.close().catch(() => {});
  }
}

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
  const currentLeader = row["Руководитель / ЛПР"] || "";

  return `You operate a virtual Chromium browser. It is already open on a Google search page.

TASK
Find public business contacts for exactly this Russian organization:
Organization: ${org}
INN: ${inn || "not known"}
Region: ${region}
City/district: ${city || "not known"}
Current phone: ${currentPhone || "empty"}
Current leader/LPR: ${currentLeader || "empty"}

REQUIRED METHOD
1. Use the visible Google web interface only. Do not use any Google API.
2. Switch to Google AI Mode through the page UI. If an AI Mode tab/button is visible, click it. If a cookie dialog appears, prefer "Reject all" / equivalent where possible.
3. In Google AI Mode, search this exact legal entity using organization name + INN when available.
4. Look for a confirmed public phone number and a confirmed leader/decision-maker. Prefer CEO/general director, logistics director, transport director, fleet manager, head of ATP, chief mechanic, procurement or another transport-related LPR.
5. Verify that every contact belongs to this exact organization. Do not merge contacts from another company with a similar name.
6. Do not sign in to Google. Do not bypass CAPTCHA, bot checks, access controls, or paywalls. Do not submit forms or send messages.
7. Stay in Google/Google AI Mode. Do not navigate to unrelated sites.

If Google AI Mode is unavailable in this browser session, blocked, requires sign-in, or a challenge prevents use, stop and return status "unavailable".
If the contact is not sufficiently confirmed, leave the field empty.

When finished, return ONLY valid JSON with exactly:
{
  "status": "ok" | "unavailable" | "not_found",
  "phone": "",
  "leader": "",
  "official_site": "",
  "note": ""
}

Use Russian phone normalization where possible: 7XXXXXXXXXX. Multiple confirmed phones separated by semicolons.`;
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

    let response = await client.responses.create({
      model: COMPUTER_MODEL,
      tools: [{ type: "computer" }],
      reasoning: { effort: "low" },
      input: agentPrompt(row, region)
    });

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (isCancelled?.()) throw new Error("JOB_CANCELLED");

      const call = (response.output || []).find((item) => item.type === "computer_call");
      if (!call) {
        const text = response.output_text || "";
        return parseJson(text);
      }

      await executeActions(page, call.actions || []);

      const host = new URL(page.url()).hostname;
      if (!/(^|\.)google\./i.test(host)) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      }

      if (await hasGoogleChallenge(page)) {
        return { status: "unavailable", phone: "", leader: "", official_site: "", note: "Google challenge/CAPTCHA" };
      }

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

    return {
      status: "unavailable",
      phone: "",
      leader: "",
      official_site: "",
      note: "Computer-use turn limit reached"
    };
  } finally {
    await context.close().catch(() => {});
  }
}

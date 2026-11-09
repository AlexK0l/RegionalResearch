// Strict five-sheet workbook based on a sanitized source Google Sheets XLSX.
// Research and HTTP stay in Node. Python is an isolated, non-network export step.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizedPhoneWorkbookData } from "./phoneExport.js";

const script = fileURLToPath(new URL("../scripts/export-reference-xlsx.py", import.meta.url));
const defaultTemplate = path.resolve("data/SAT_reference_template.xlsx");

export async function buildReferenceWorkbookBuffer(result, { templatePath = "" } = {}) {
  const template = path.resolve(String(templatePath ||
    process.env.SAT_XLSX_TEMPLATE_PATH || defaultTemplate));
  try { await fs.access(template); }
  catch { throw new Error("Reference XLSX template missing: " + template +
    " (download sanitized reference and set SAT_XLSX_TEMPLATE_PATH)"); }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sat-reference-export-"));
  const output = path.join(folder, "result.xlsx");
  const python = String(process.env.SAT_PYTHON_BIN || "python").trim();
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(python, [script, template, output],
        { stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
      let stderr = "";
      let settled = false;
      child.stderr.on("data", data => { stderr += data.toString().slice(0, 8192); });
      child.once("error", error => {
        if (!settled) { settled = true; reject(new Error("Python export unavailable: " + error.message)); }
      });
      child.once("close", code => {
        if (settled) return;
        settled = true;
        if (code !== 0) reject(new Error("Strict XLSX export failed: " + (stderr || "exit " + code)));
        else resolve();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(sanitizedPhoneWorkbookData(result || {})), "utf8");
    });
    return await fs.readFile(output);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

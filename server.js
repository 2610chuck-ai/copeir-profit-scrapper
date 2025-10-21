// server.js (ESM)
// Robust, seriell, mit Browser-Singleton & Retry

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------
// In-Memory Cache der letzten Ergebnisse
// ---------------------------------------------
let LAST_RESULTS = { updatedAt: null, items: [] };

// ---------------------------------------------
// Robustes Browser-Handling (Singleton + Retry)
// ---------------------------------------------
let browserPromise = null;

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-breakpad",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

async function getBrowser() {
  try {
    if (!browserPromise) browserPromise = launchBrowser();
    const b = await browserPromise;
    if (!b || b.isConnected?.() === false) {
      try { await b?.close(); } catch {}
      browserPromise = launchBrowser();
      return await browserPromise;
    }
    return b;
  } catch (e) {
    try { (await browserPromise)?.close(); } catch {}
    browserPromise = launchBrowser();
    return await browserPromise;
  }
}

// Einmaliger Retry bei „Browser/Page/Context closed“ o.ä.
async function withRetry(fn, label = "task") {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e || "");
    const shouldRetry =
      /Target page|context|browser has been closed|Browser has been closed|browserType\.launch|Executable doesn't exist/.test(
        msg
      );
    if (!shouldRetry) throw e;

    // Browser neu aufsetzen und einmal wiederholen
    try { (await browserPromise)?.close(); } catch {}
    browserPromise = launchBrowser();
    return await fn();
  }
}

// ---------------------------------------------
// Hilfen
// ---------------------------------------------
function parseAnyNumber(raw) {
  if (!raw) return null;
  // Nur Ziffern, . , und -/+ behalten
  const cleaned = String(raw).replace(/[^\d,.\-+]/g, "");

  // Tausender/Dezimal robust:
  const lc = cleaned.lastIndexOf(",");
  const ld = cleaned.lastIndexOf(".");
  const ls = Math.max(lc, ld);

  let normalized = cleaned;
  if (lc !== -1 && ld !== -1) {
    // beide vorhanden → der letzte trennt die Nachkommastellen
    normalized = cleaned.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
  } else if (lc !== -1) {
    // nur , → Nachkommastellen, . als Tausender entfernen
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // nur . → als Dezimalpunkt, , entfernen
    normalized = cleaned.replace(/,/g, "");
  }

  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

// ---------------------------------------------
// Kern: einen Profit von einer Seite holen
// - Entweder per CSS-Selector (`sel`) → innerText
// - Oder per Textsuche (`text`) → erste sichtbare Stelle, die den Text enthält
// ---------------------------------------------
async function fetchProfitFromPage(page, { url, sel, text }) {
  await page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(800);

  let raw = null;

  if (sel) {
    // CSS-Selector
    const el = await page.waitForSelector(sel, { timeout: 30000 });
    raw = await el.evaluate((n) => n.innerText || n.textContent || "");
  } else if (text) {
    raw = await page.evaluate((needle) => {
      const visible = (e) => {
        const s = getComputedStyle(e);
        return s && s.visibility !== "hidden" && s.display !== "none";
      };
      const all = Array.from(document.querySelectorAll("body *"));
      const el = all.find((e) => visible(e) && e.innerText && e.innerText.includes(needle));
      return el ? el.innerText : null;
    }, String(text));
    if (!raw) throw new Error("Text not found: " + text);
  } else {
    throw new Error("Need either 'sel' or 'text' for scraping.");
  }

  // Zahl extrahieren (erste Nummer im String)
  const m = String(raw).match(/[+\-]?\d{1,3}([.,]\d{3})*([.,]\d+)?/);
  const num = parseAnyNumber(m ? m[0] : raw);

  return { raw, profit: num };
}

// ---------------------------------------------
// Gesamten Satz aus copierprofit.json scrapen
// copierprofit.json-Format (Minimal):
// [
//   { "name": "Follower 1", "start": "2025-10-02", "capital": 21496.53,
//     "url": "https://.../futures-followers", "sel": "#__layout span.text-content-trade-buy-text" }
//   // oder statt "sel" -> "text": "Gewinn" (wird auf Seite gesucht)
// ]
// ---------------------------------------------
async function scrapeAllFollowers() {
  const cfgPath = path.join(__dirname, "copierprofit.json");
  let data;
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error("copierprofit.json konnte nicht gelesen werden: " + String(e));
  }

  if (!Array.isArray(data)) throw new Error("copierprofit.json muss ein Array sein.");

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await context.newPage();

  const results = [];

  try {
    // SERIELL! Keine parallelen Seiten.
    for (const item of data) {
      const { name, start, capital, url, sel, text } = item;

      let profit = null;
      let raw = null;
      let ok = true;
      let error = null;

      if (url && (sel || text)) {
        try {
          const r = await fetchProfitFromPage(page, { url, sel, text });
          raw = r.raw;
          profit = r.profit;
        } catch (e) {
          ok = false;
          error = String(e);
        }
      }

      results.push({
        name: name ?? "",
        start: start ?? null,
        capital: Number(capital ?? 0),
        ok,
        error,
        live: { raw, profit },
      });
    }
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }

  LAST_RESULTS = { updatedAt: new Date().toISOString(), items: results };
  return LAST_RESULTS;
}

// ---------------------------------------------
// Routen
// ---------------------------------------------

// Health
app.get("/", (req, res) => res.type("text").send("OK"));

// Zuletzt gespeicherte Ergebnisse
app.get("/api/last-results", (req, res) => {
  res.json(LAST_RESULTS);
});

// Manuelles Refresh (POST!)
app.post("/api/refresh-now", async (req, res) => {
  try {
    const payload = await withRetry(() => scrapeAllFollowers(), "refresh-all");
    res.json({ ok: true, ...payload });
  } catch (e) {
    // Für Diagnose: Browserlogs zurückgeben
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------
// Warmup (sanft, ohne die echte Liste zu scrapen)
// ---------------------------------------------
(async () => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await p.close();
    await ctx.close();
    console.log("Warmup done");
  } catch (e) {
    console.log("Warmup skipped:", String(e));
  }
})();

// Graceful Shutdown
process.on("SIGTERM", async () => {
  try { (await browserPromise)?.close(); } finally { process.exit(0); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Scraper API ready on :" + PORT));


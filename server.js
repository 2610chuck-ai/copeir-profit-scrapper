// server.js – angepasst auf copierprofit.json { currency, copiers: [...] }

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

// ----------------------- Cache -----------------------
let LAST_RESULTS = { updatedAt: null, currency: "USDT", items: [] };

// ------------------ Browser-Singleton ----------------
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
  } catch {
    try { (await browserPromise)?.close(); } catch {}
    browserPromise = launchBrowser();
    return await browserPromise;
  }
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e || "");
    const shouldRetry =
      /Target page|context|browser has been closed|Browser has been closed|browserType\.launch|Executable doesn't exist/.test(
        msg
      );
    if (!shouldRetry) throw e;
    try { (await browserPromise)?.close(); } catch {}
    browserPromise = launchBrowser();
    return await fn();
  }
}

// ----------------- Utilities -----------------
function parseAnyNumber(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d,.\-+]/g, "");
  const lc = cleaned.lastIndexOf(",");
  const ld = cleaned.lastIndexOf(".");
  const ls = Math.max(lc, ld);
  let normalized = cleaned;
  if (lc !== -1 && ld !== -1) {
    normalized = cleaned.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
  } else if (lc !== -1) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

// ----------------- Core scrape -----------------
// Holt Gewinn für EINEN Follower anhand von `who` auf `sourceUrl`.
async function fetchProfitForCopier(page, { sourceUrl, who }) {
  await page.goto(String(sourceUrl), { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(800);

  // Im DOM: Block für die Person finden (who-Text) und darin die erste Zahl mit +/- abgreifen.
  const found = await page.evaluate((needle) => {
    function visible(el) {
      const s = getComputedStyle(el);
      return s && s.visibility !== "hidden" && s.display !== "none";
    }
    // Alle sichtbaren Elemente, die den Namen enthalten
    const matches = Array.from(document.querySelectorAll("body *"))
      .filter((e) => visible(e) && e.innerText && e.innerText.includes(needle));

    if (!matches.length) return { raw: null, blockText: null };

    // Nimm einen sinnvollen Container (li/section/article/div), sonst das Element selbst
    const container =
      matches
        .map((e) => e.closest("li,article,section,div"))
        .find(Boolean) || matches[0];

    const text = container?.innerText || matches[0].innerText || "";

    // Suche nach Zahl mit Vorzeichen (grüne Gewinne sind meist mit "+")
    const numbers = text.match(/[+\-]?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g);
    let pick = null;
    if (numbers && numbers.length) {
      // bevorzugt Werte mit Vorzeichen
      pick = numbers.find((s) => /^[+\-]/.test(s)) || numbers[0];
    }
    return { raw: pick, blockText: text };
  }, String(who));

  const raw = found?.raw || null;
  const profit = parseAnyNumber(raw);
  return { raw, profit, debug: found?.blockText || null };
}

// Liest dein copierprofit.json (Objekt mit currency + copiers[]) und scrapt alle
async function scrapeAllFollowers() {
  const cfgPath = path.join(__dirname, "copierprofit.json");
  let cfg;
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error("copierprofit.json konnte nicht gelesen werden: " + String(e));
  }

  if (!cfg || !Array.isArray(cfg.copiers)) {
    throw new Error("copierprofit.json muss { currency, copiers:[...] } enthalten.");
  }

  const currency = cfg.currency || "USDT";
  const copiers = cfg.copiers;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await context.newPage();

  const items = [];
  try {
    // SERIELL abarbeiten (stabiler im Free-Plan)
    for (const c of copiers) {
      const { name, start, capital, sourceUrl, who } = c;
      let ok = true, error = null, raw = null, profit = null;

      if (sourceUrl && who) {
        try {
          const r = await fetchProfitForCopier(page, { sourceUrl, who });
          raw = r.raw;
          profit = r.profit;
          // Du kannst r.debug in Logs schreiben, wenn du willst:
          // console.log("DEBUG TEXT for", who, r.debug?.slice(0,200));
        } catch (e) {
          ok = false;
          error = String(e);
        }
      } else {
        ok = false;
        error = "sourceUrl und who sind Pflicht";
      }

      items.push({
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

  LAST_RESULTS = {
    updatedAt: new Date().toISOString(),
    currency,
    items,
  };
  return LAST_RESULTS;
}

// ----------------- Routes -----------------
app.get("/", (req, res) => res.type("text").send("OK"));

app.get("/api/last-results", (req, res) => {
  res.json(LAST_RESULTS);
});

// WICHTIG: POST verwenden!
app.post("/api/refresh-now", async (req, res) => {
  try {
    const payload = await withRetry(() => scrapeAllFollowers());
    res.json({ ok: true, ...payload });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ----------------- Warmup -----------------
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

// Graceful shutdown
process.on("SIGTERM", async () => {
  try { (await browserPromise)?.close(); } finally { process.exit(0); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Scraper API ready on :" + PORT));

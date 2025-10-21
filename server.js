// server.js (final fix): uses copierprofit.json, maps profits by 'who', returns items with capital/start/roi
import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

// In-memory cache
let lastResults = { updatedAt: null, items: [] };

// Browser singleton
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
    });
  }
  return browserPromise;
}

// Parse number in +7.006,6 / +2,804.05 etc.
function parseProfit(rawText) {
  if (!rawText) return null;
  const only = String(rawText).replace(/[\sA-Za-z]/g,"").replace(/[^0-9,\.\-+]/g, "");
  const lc = only.lastIndexOf(",");
  const ld = only.lastIndexOf(".");
  const ls = Math.max(lc, ld);
  let num = only;
  if (lc !== -1 && ld !== -1) {
    num = only.replace(/[,.]/g, (m, i) => (i === ls ? "." : ""));
  } else if (lc !== -1) {
    num = only.replace(/\./g, "").replace(",", ".");
  } else {
    num = only.replace(/,/g, "");
  }
  const v = parseFloat(num);
  return Number.isFinite(v) ? v : null;
}

// Load config
async function loadConfig() {
  const p = path.resolve(__dirname, "copierprofit.json");
  const txt = await fs.readFile(p, "utf-8");
  return JSON.parse(txt);
}

// Scrape all profits for copiers defined in copierprofit.json (single page visit)
async function scrapeAll() {
  const cfg = await loadConfig();
  const copiers = Array.isArray(cfg.copiers) ? cfg.copiers : [];
  if (copiers.length === 0) return [];

  // group by sourceUrl to minimize page loads
  const groups = new Map();
  for (const c of copiers) {
    const key = c.sourceUrl || "default";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const browser = await getBrowser();
  const results = [];

  for (const [sourceUrl, list] of groups.entries()) {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    });
    const page = await ctx.newPage();
    try {
      await page.goto(sourceUrl, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(1500);

      for (const c of list) {
        try {
          // find the card by visible text (name)
          const card = page.locator(`div:has-text("${c.who || c.name}")`).first();
          await card.waitFor({ state: "visible", timeout: 15000 });
          const gainEl = card.locator("span.text-content-trade-buy-text").first();
          const raw = await gainEl.innerText();
          const profit = parseProfit(raw) ?? 0;

          const item = {
            name: c.name,
            start: c.start || null,
            capital: Number(c.capital) || 0,
            profit,
            roi: (Number(c.capital) ? (profit / Number(c.capital)) * 100 : 0),
            who: c.who || null
          };
          results.push(item);
        } catch (e) {
          results.push({
            name: c.name,
            start: c.start || null,
            capital: Number(c.capital) || 0,
            profit: null,
            roi: null,
            who: c.who || null,
            error: String(e)
          });
        }
      }
    } finally {
      try { await page.close(); } catch {}
      try { await ctx.close(); } catch {}
    }
  }

  return results;
}

// Routes
app.get("/healthz", (req, res) => res.type("text").send("OK"));

// Cached results for frontend
app.get("/api/last-results", (req, res) => {
  res.json(lastResults);
});

// Allow preflight
app.options("/api/refresh-now", (req, res) => res.sendStatus(204));

// Trigger refresh (POST)
app.post("/api/refresh-now", async (req, res) => {
  try {
    const items = await scrapeAll();
    lastResults = { updatedAt: new Date().toISOString(), items };
    res.json({ ok: true, updatedAt: lastResults.updatedAt, count: items.length });
  } catch (e) {
    console.error("refresh-now error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Warmup
(async () => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await p.close(); await ctx.close();
    console.log("Warmup done");
  } catch (e) {
    console.log("Warmup skipped:", String(e));
  }
})();

// Graceful shutdown
process.on("SIGTERM", async () => {
  try { if (browserPromise) (await browserPromise).close(); } finally { process.exit(0); }
});

app.listen(process.env.PORT || 3000, () => console.log("Scraper API ready"));

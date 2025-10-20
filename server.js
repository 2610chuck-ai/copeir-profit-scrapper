import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";
import fetch from "node-fetch"; // falls nicht vorhanden: npm i node-fetch@3

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COPIER_JSON_URL = process.env.COPIER_JSON_URL;   // z.B. https://finkfuture.com/copierprofit.json
const REFRESH_TOKEN   = process.env.REFRESH_TOKEN || ""; // optional

// ---------- Browser Handling ----------
let browserInstance = null;
async function getBrowser() {
  if (browserInstance) return browserInstance;
  browserInstance = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browserInstance;
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseNumber(raw) {
  if (!raw) return null;
  const norm = String(raw).replace(/[^0-9,.\-+]/g, "");
  const lc = norm.lastIndexOf(","), ld = norm.lastIndexOf(".");
  const ls = Math.max(lc, ld);
  let s = norm;
  if (lc !== -1 && ld !== -1) s = norm.replace(/[,\.]/g, (m,i)=> (i===ls? ".": ""));
  else if (lc !== -1) s = norm.replace(/\./g,"").replace(",",".");
  else s = norm.replace(/,/g,"");
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

async function scrapeOne({ sourceUrl, who, selector, nth }) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await ctx.newPage();
  try {
    await page.goto(sourceUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1200);

    let raw = null;

    if (who) {
      const card = page.locator(`div:has-text("${who}")`).first();
      await card.waitFor({ state: "visible", timeout: 30000 });
      const gains = card.locator("span.text-content-trade-buy-text");
      const count = await gains.count();
      if (count === 0) throw new Error("Kein Gewinn-Element für " + who);
      raw = await gains.nth(0).innerText();
    } else if (selector) {
      const items = page.locator(selector);
      const count = await items.count();
      if (count === 0) throw new Error("Selector ohne Treffer");
      const index = nth ? Math.max(0, Math.min(nth - 1, count - 1)) : 0;
      raw = await items.nth(index).innerText();
    } else {
      throw new Error("Weder who noch selector gesetzt");
    }

    const profit = parseNumber(raw);
    return { raw, profit };
  } finally {
    try { await page.close(); } catch {}
    try { await ctx.close(); } catch {}
  }
}

// ---------- Public API: Einzelabruf wie gehabt ----------
app.get("/api/scrape-profit", async (req, res) => {
  const url  = String(req.query.url || "");
  const sel  = req.query.sel  ? String(req.query.sel)  : null;
  const text = req.query.text ? String(req.query.text) : null; // (nicht genutzt in auto cache)
  const nth  = req.query.nth  ? Number(req.query.nth)  : null;
  const who  = req.query.who  ? String(req.query.who)  : null;
  if (!url || (!sel && !who && !text)) {
    return res.status(400).json({ error: "Benötige URL und (sel, who oder text)" });
  }
  try {
    const { raw, profit } = await scrapeOne({ sourceUrl: url, who, selector: sel, nth });
    return res.json({ profit: Number.isFinite(profit) ? profit : null, raw });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ---------- Auto Cache ----------
let lastResults = { updatedAt: null, items: [] };

async function refreshCache() {
  if (!COPIER_JSON_URL) {
    console.log("⛔ COPIER_JSON_URL nicht gesetzt – überspringe Auto-Refresh");
    return;
  }
  try {
    const resp = await fetch(COPIER_JSON_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("Fetch copier JSON failed: " + resp.status);
    const cfg = await resp.json();
    const copiers = Array.isArray(cfg.copiers) ? cfg.copiers : [];
    const items = [];
    for (const c of copiers) {
      try {
        const { raw, profit } = await scrapeOne({
          sourceUrl: c.sourceUrl,
          who: c.who || null,
          selector: c.selector || null,
          nth: c.nth || null,
        });
        items.push({
          name: c.name,
          capital: c.capital,
          start: c.start,
          sourceUrl: c.sourceUrl,
          who: c.who || null,
          selector: c.selector || null,
          nth: c.nth || null,
          profit
        });
      } catch (e) {
        items.push({
          name: c.name,
          capital: c.capital,
          start: c.start,
          sourceUrl: c.sourceUrl,
          who: c.who || null,
          selector: c.selector || null,
          nth: c.nth || null,
          profit: null,
          error: String(e)
        });
      }
      // kleine Pause, Bitget nicht zu hart treffen
      await sleep(400);
    }
    lastResults = { updatedAt: new Date().toISOString(), items };
    console.log(`✅ Cache aktualisiert (${items.length} Kopierer)`);
  } catch (e) {
    console.log("Auto-Refresh Fehler:", String(e));
  }
}

// Startup + stündlich
(async () => {
  await refreshCache();
  setInterval(refreshCache, 60 * 60 * 1000); // 1 Stunde
})();

// Endpoint: gecachte Ergebnisse
app.get("/api/last-results", (req, res) => {
  res.json(lastResults);
});

// Manuelles Refresh (optional mit Token)
app.post("/api/refresh-now", async (req, res) => {
  if (REFRESH_TOKEN && req.query.token !== REFRESH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await refreshCache();
  res.json({ ok: true, updatedAt: lastResults.updatedAt });
});

// ---------- Root ----------
app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));

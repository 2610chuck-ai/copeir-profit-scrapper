import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COPIER_JSON_URL = process.env.COPIER_JSON_URL;
const REFRESH_TOKEN   = process.env.REFRESH_TOKEN || "";

let browserInstance = null;
async function getBrowser() {
  if (browserInstance) return browserInstance;
  browserInstance = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browserInstance;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseNumber(raw) {
  if (!raw) return null;
  const norm = String(raw).replace(/[^0-9,.\-+]/g, "");
  const lc = norm.lastIndexOf(","), ld = norm.lastIndexOf(".");
  const ls = Math.max(lc, ld);
  let s = norm;
  if (lc !== -1 && ld !== -1) s = norm.replace(/[,\.]/g, (m,i)=> (i===ls? ".": ""));
  else if (lc !== -1) s = norm.replace(/\./g,"").replace(",","."); else s = norm.replace(/,/g,"");
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

async function scrapeOne({ sourceUrl, who, selector, nth }) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" });
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
    } else throw new Error("Weder who noch selector gesetzt");

    const profit = parseNumber(raw);
    return { raw, profit };
  } finally {
    try { await page.close(); } catch {}
    try { await ctx.close(); } catch {}
  }
}

app.get("/api/scrape-profit", async (req, res) => {
  const url  = String(req.query.url || "");
  const sel  = req.query.sel  ? String(req.query.sel)  : null;
  const nth  = req.query.nth  ? Number(req.query.nth)  : null;
  const who  = req.query.who  ? String(req.query.who)  : null;
  if (!url || (!sel && !who)) return res.status(400).json({ error: "Need url and sel or who" });
  try {
    const { raw, profit } = await scrapeOne({ sourceUrl: url, who, selector: sel, nth });
    res.json({ profit, raw });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

let lastResults = { updatedAt: null, items: [] };

async function refreshCache() {
  if (!COPIER_JSON_URL) return;
  try {
    const resp = await fetch(COPIER_JSON_URL);
    const cfg = await resp.json();
    const copiers = Array.isArray(cfg.copiers) ? cfg.copiers : [];
    const items = [];
    for (const c of copiers) {
      try {
        const { raw, profit } = await scrapeOne({
          sourceUrl: c.sourceUrl,
          who: c.who || null,
          selector: c.selector || null,
          nth: c.nth || null
        });
        items.push({ ...c, profit });
      } catch (e) {
        items.push({ ...c, profit: null, error: String(e) });
      }
      await sleep(400);
    }
    lastResults = { updatedAt: new Date().toISOString(), items };
    console.log("✅ Cache aktualisiert:", items.length);
  } catch (e) {
    console.log("Fehler beim Refresh:", e);
  }
}

(async () => {
  await refreshCache();
  setInterval(refreshCache, 60*60*1000);
})();

app.get("/api/last-results", (req, res) => res.json(lastResults));

app.post("/api/refresh-now", async (req, res) => {
  if (REFRESH_TOKEN && req.query.token !== REFRESH_TOKEN)
    return res.status(401).json({ error: "Unauthorized" });
  await refreshCache();
  res.json({ ok: true, updatedAt: lastResults.updatedAt });
});

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("✅ Server läuft auf Port", PORT));
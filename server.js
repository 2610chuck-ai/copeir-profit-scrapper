import express from "express";
import { chromium } from "playwright";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  return browserPromise;
}

app.get("/", (_req, res) => res.type("text").send("OK"));

app.get("/api/scrape-profit", async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel && String(req.query.sel).trim();
  const txt = req.query.text && String(req.query.text).trim();
  const nth = req.query.nth ? Math.max(1, parseInt(String(req.query.nth), 10)) : null;
  const wantAll = String(req.query.all || '').toLowerCase() === '1';

  if (!url || (!sel && !txt && !wantAll)) {
    return res.status(400).json({ error: "Need url and (sel OR text) or set all=1" });
  }

  let ctx, page;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
      viewport: { width: 1366, height: 900 }
    });
    page = await ctx.newPage();

    await page.goto(String(url), { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1500);

    const parseNum = (raw) => {
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
    };

    let texts = [];
    if (sel) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        texts = await page.$$eval(sel, els => els.map(e => e.innerText?.trim() || "").filter(Boolean));
      } catch {}
    }
    if (texts.length === 0) {
      texts = await page.evaluate((needle) => {
        function vis(el){ const s=getComputedStyle(el); return s && s.visibility!=="hidden" && s.display!=="none";}
        const arr = [];
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          if (!vis(el)) continue;
          const t = el.innerText?.trim();
          if (!t) continue;
          if (!needle || t.includes(needle)) arr.push(t);
        }
        return arr;
      }, txt || null);
    }

    const numRe = /[-+]?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g;
    const matches = [];
    for (const t of texts) {
      const parts = t.match(numRe);
      if (parts) for (const p of parts) matches.push({ raw: p, profit: parseNum(p) });
    }
    const nums = matches.filter(m => m.profit !== null);

    if (wantAll) {
      return res.json({ count: nums.length, items: nums });
    }

    const pick = (nth && nums[nth-1]) || nums[0];
    if (!pick) throw new Error("No number found");
    return res.json({ ...pick, index: nth || 1, total: nums.length });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (ctx) await ctx.close(); } catch {}
  }
});

(async () => {
  try {
    const b = await getBrowser();
    const c = await b.newContext();
    const p = await c.newPage();
    await p.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await p.close(); await c.close();
    console.log("Warmup done");
  } catch (e) {
    console.log("Warmup skipped:", String(e));
  }
})();

process.on("SIGTERM", async () => {
  try { if (browserPromise) (await browserPromise).close(); }
  finally { process.exit(0); }
});

app.listen(process.env.PORT || 3000, () => console.log("Scraper API ready"));

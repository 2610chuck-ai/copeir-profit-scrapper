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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote"
      ],
      headless: true
    });
  }
  return browserPromise;
}

app.get("/", (_req, res) => res.type("text").send("OK"));

app.get("/api/scrape-profit", async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel && String(req.query.sel).trim();
  const txt = req.query.text && String(req.query.text).trim();
  if (!url || (!sel && !txt)) {
    return res.status(400).json({ error: "Need url and sel OR text" });
  }

  let ctx, page;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
      viewport: { width: 1366, height: 900 }
    });
    page = await ctx.newPage();

    await page.goto(String(url), { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1800);

    const parseNumber = (raw) => {
      if (!raw) return NaN;
      const norm = raw.replace(/[^0-9,.\-]/g, "");
      const lc = norm.lastIndexOf(","), ld = norm.lastIndexOf(".");
      const ls = Math.max(lc, ld);
      let num = norm;
      if (lc !== -1 && ld !== -1) num = norm.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
      else if (lc !== -1) num = norm.replace(/\./g, "").replace(",", ".");
      else num = norm.replace(/,/g, "");
      return parseFloat(num);
    };

    let raw = null;

    if (sel) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        raw = await page.$eval(sel, (el) => el.innerText?.trim() || "");
      } catch {}
    }

    if (!raw) {
      try {
        raw = await page.$$eval(".text-content-trade-buy-text", (els) => {
          for (const el of els) {
            const t = el.innerText?.trim();
            if (t && /[-+]?[\d\.,]+\b/.test(t)) return t;
          }
          return null;
        });
      } catch {}
    }

    if (!raw) {
      raw = await page.evaluate((needle) => {
        function vis(el) {
          const s = getComputedStyle(el);
          return s && s.visibility !== "hidden" && s.display !== "none";
        }
        const els = Array.from(document.querySelectorAll("body *"));
        for (const el of els) {
          if (!vis(el)) continue;
          const t = el.innerText?.trim();
          if (!t) continue;
          const m = t.match(/[-+]?[\d]{1,3}([.,]\d{3})*([.,]\d+)?/);
          if (m && (!needle || t.includes(needle))) return m[0];
        }
        return null;
      }, txt || null);
    }

    if (!raw) throw new Error("No number found");

    const profit = parseNumber(raw);
    res.json({ profit: Number.isFinite(profit) ? profit : null, raw });
  } catch (e) {
    res.status(500).json({ error: String(e) });
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

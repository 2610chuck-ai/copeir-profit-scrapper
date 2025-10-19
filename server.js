import express from "express";
import { chromium } from "playwright";

const app = express();

// CORS (Frontend darf zugreifen)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Healthcheck
app.get("/", (req, res) => res.type("text").send("OK"));

// Hauptroute
app.get("/api/scrape-profit", async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel;     // CSS-Selector (optional)
  const txt = req.query.text;    // Alternativ Textsuche (optional)
  if (!url || (!sel && !txt)) return res.status(400).json({ error: "Need url and sel OR text" });

  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(String(url), { waitUntil: "networkidle", timeout: 60000 });

    let raw;
    if (sel) {
      await page.waitForSelector(String(sel), { timeout: 30000 });
      raw = await page.$eval(String(sel), el => el.innerText.trim());
    } else {
      // einfache Textsuche
      raw = await page.evaluate((needle) => {
        function vis(el){ const s=getComputedStyle(el); return s && s.visibility!=='hidden' && s.display!=='none'; }
        const all = Array.from(document.querySelectorAll("body *"));
        const el = all.find(e => vis(e) && e.innerText && e.innerText.includes(needle));
        return el ? el.innerText.trim() : null;
      }, String(txt));
      if (!raw) throw new Error("Text not found");
    }

    // Zahl herausziehen (DE/EN)
    const normalized = raw.replace(/[^0-9,.\-]/g,"");
    const lc = normalized.lastIndexOf(","), ld = normalized.lastIndexOf(".");
    const ls = Math.max(lc, ld);
    let num = normalized;
    if (lc!==-1 && ld!==-1) num = normalized.replace(/[,\.]/g,(m,i)=> i===ls ? "." : "");
    else if (lc!==-1)       num = normalized.replace(/\./g,"").replace(",", ".");
    else                    num = normalized.replace(/,/g,"");
    const profit = parseFloat(num);

    res.json({ profit: Number.isFinite(profit) ? profit : null, raw });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Scraper API ready"));

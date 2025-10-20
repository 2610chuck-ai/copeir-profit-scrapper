import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

// ---------- Profit Scraper API ----------
app.get("/api/scrape-profit", async (req, res) => {
  const url  = String(req.query.url || "");
  const sel  = req.query.sel  ? String(req.query.sel)  : null;
  const text = req.query.text ? String(req.query.text) : null;
  const nth  = req.query.nth  ? Number(req.query.nth)  : null;
  const who  = req.query.who  ? String(req.query.who)  : null;

  if (!url || (!sel && !text && !who)) {
    return res.status(400).json({ error: "Benötige URL und (sel, text oder who) Parameter." });
  }

  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    });
    page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);

    let raw = null;

    // -------- WHO: Suche anhand Namen --------
    if (who) {
      const card = page.locator(`div:has-text("${who}")`).first();
      await card.waitFor({ state: "visible", timeout: 30000 });
      const gains = card.locator("span.text-content-trade-buy-text");
      const count = await gains.count();
      if (count === 0) throw new Error("Kein Gewinn-Element für " + who);
      raw = await gains.nth(0).innerText();
    }
    // -------- Fallback: CSS Selector --------
    else if (sel) {
      const elements = page.locator(sel);
      const count = await elements.count();
      if (count === 0) throw new Error("Selector hat keine Treffer");
      const index = nth ? Math.max(0, Math.min(nth - 1, count - 1)) : 0;
      raw = await elements.nth(index).innerText();
    }
    // -------- Fallback: Textsuche --------
    else if (text) {
      const matches = await page.evaluate((needle) => {
        function vis(el) {
          const s = getComputedStyle(el);
          return s && s.visibility !== "hidden" && s.display !== "none";
        }
        const all = Array.from(document.querySelectorAll("body *"));
        const arr = [];
        for (const e of all) {
          if (vis(e) && e.innerText && e.innerText.includes(needle)) {
            arr.push(e.innerText.trim());
          }
        }
        return arr;
      }, text);
      if (!matches || matches.length === 0) throw new Error("Text nicht gefunden");
      const index = nth ? Math.max(0, Math.min(nth - 1, matches.length - 1)) : 0;
      raw = matches[index];
    }

    // -------- Zahl bereinigen --------
    const normalized = String(raw).replace(/[^0-9,\.\-]/g, "");
    const lc = normalized.lastIndexOf(",");
    const ld = normalized.lastIndexOf(".");
    const ls = Math.max(lc, ld);
    let num = normalized;
    if (lc !== -1 && ld !== -1)
      num = normalized.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
    else if (lc !== -1)
      num = normalized.replace(/\./g, "").replace(",", ".");
    else
      num = normalized.replace(/,/g, "");

    const profit = parseFloat(num);

    return res.json({ profit: Number.isFinite(profit) ? profit : null });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
  }
});

// ---------- Root ----------
app.get("/", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));

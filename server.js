import express from "express";
import { chromium } from "playwright";

const app = express();

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// --- globaler Browser (Singleton) ---
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
        "--no-zygote",
      ],
      headless: true,
    });
  }
  return browserPromise;
}

// --- Healthcheck & einfache Ping-Route ---
app.get("/", (req, res) => res.type("text").send("OK"));
app.get("/api/ping", (req, res) => res.json({ ok: true, t: Date.now() }));

// --- Haupt-Route ---
app.get("/api/scrape-profit", async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel;   // optional: CSS-Selector
  const txt = req.query.text;  // optional: Textsuche
  if (!url || (!sel && !txt)) {
    return res.status(400).json({ error: "Need url and sel OR text" });
  }

  let context, page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    });
    page = await context.newPage();

    await page.goto(String(url), { waitUntil: "networkidle", timeout: 60000 });
    // kleiner Puffer, weil viele Seiten noch nachladen
    await page.waitForTimeout(1200);

    let raw;
    if (sel) {
      await page.waitForSelector(String(sel), { timeout: 30000 });
      raw = await page.$eval(String(sel), (el) => el.innerText.trim());
    } else {
      raw = await page.evaluate((needle) => {
        function vis(el) {
          const s = getComputedStyle(el);
          return s && s.visibility !== "hidden" && s.display !== "none";
        }
        const all = Array.from(document.querySelectorAll("body *"));
        const el = all.find((e) => vis(e) && e.innerText && e.innerText.includes(needle));
        return el ? el.innerText.trim() : null;
      }, String(txt));
      if (!raw) throw new Error("Text not found");
    }

    // Zahl robust parsen (de/en)
    const normalized = raw.replace(/[^0-9,.\-]/g, "");
    const lc = normalized.lastIndexOf(","),
      ld = normalized.lastIndexOf(".");
    const ls = Math.max(lc, ld);
    let num = normalized;
    if (lc !== -1 && ld !== -1) num = normalized.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
    else if (lc !== -1) num = normalized.replace(/\./g, "").replace(",", ".");
    else num = normalized.replace(/,/g, "");
    const profit = parseFloat(num);

    res.json({ profit: Number.isFinite(profit) ? profit : null, raw });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

// --- Warmup beim Start: Browser vorbereiten ---
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

// --- Graceful shutdown (Render Stop/Restart) ---
process.on("SIGTERM", async () => {
  try {
    if (browserPromise) (await browserPromise).close();
  } finally {
    process.exit(0);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Scraper API ready"));

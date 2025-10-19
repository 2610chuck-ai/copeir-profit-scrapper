// --- robust server.js für Render ---
// Falls Playwright zur Laufzeit doch noch den globalen Pfad nutzt:
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

import express from "express";
import { chromium } from "playwright";

const app = express();

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// ---------- Browser-Management (Singleton + Auto-Heal) ----------
let browserPromise = null;

async function createBrowser() {
  // Minimal-Flags, die auf Render stabil sind
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // die beiden sind fehleranfällig, daher NICHT nutzen:
      // "--single-process",
      // "--no-zygote",
    ],
  });
}

async function getBrowser() {
  // Falls nie erzeugt, erstellen
  if (!browserPromise) browserPromise = createBrowser();
  let browser;
  try {
    browser = await browserPromise;
    // wenn Render den Prozess gekillt hat:
    if (!browser || !browser.isConnected()) throw new Error("browser not connected");
    return browser;
  } catch (_) {
    // Neu starten (Auto-Heal)
    try {
      if (browser && browser.isConnected()) await browser.close().catch(() => {});
    } catch {}
    browserPromise = createBrowser();
    return browserPromise;
  }
}

async function resetBrowser() {
  try {
    const b = browserPromise ? await browserPromise : null;
    if (b && b.isConnected()) await b.close().catch(() => {});
  } catch {}
  browserPromise = null;
  return getBrowser();
}

// ---------- Health ----------
app.get("/", (_req, res) => res.type("text").send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true, t: Date.now() }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// ---------- Haupt-Route ----------
app.get("/api/scrape-profit", async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel;   // CSS-Selector (optional)
  const txt = req.query.text;  // Textsuche (optional)

  if (!url || (!sel && !txt)) {
    return res.status(400).json({ error: "Need url and sel OR text" });
  }

  // Retry-Logik, falls Render im Free-Plan den Browser „abschießt“
  const attempt = async () => {
    let context, page;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      });
      page = await context.newPage();

      await page.goto(String(url), { waitUntil: "networkidle", timeout: 60000 });
      // kleine Extra-Wartezeit für dynamische Seiten
      await page.waitForTimeout(1200);

      let raw;
      if (sel) {
        await page.waitForSelector(String(sel), { timeout: 30000 });
        raw = await page.$eval(String(sel), (el) => el.innerText.trim());
      } else {
        // einfache Textsuche (erstes sichtbares Element mit diesem Teilstring)
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
      const lc = normalized.lastIndexOf(",");
      const ld = normalized.lastIndexOf(".");
      const ls = Math.max(lc, ld);
      let num = normalized;
      if (lc !== -1 && ld !== -1) {
        num = normalized.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
      } else if (lc !== -1) {
        num = normalized.replace(/\./g, "").replace(",", ".");
      } else {
        num = normalized.replace(/,/g, "");
      }
      const profit = parseFloat(num);

      return { profit: Number.isFinite(profit) ? profit : null, raw };
    } finally {
      // immer sauber schließen (nicht den globalen Browser!)
      try { if (page) await page.close(); } catch {}
      try { if (context) await context.close(); } catch {}
    }
  };

  try {
    // 1. Versuch
    try {
      const out = await attempt();
      return res.json(out);
    } catch (e1) {
      // Wenn der Browser zwischendurch gekillt wurde: Browser neu starten, 2. Versuch
      await resetBrowser();
      const out2 = await attempt();
      return res.json(out2);
    }
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ---------- Warmup beim Start ----------
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

// ---------- Graceful shutdown ----------
process.on("SIGTERM", async () => {
  try {
    if (browserPromise) (await browserPromise).close();
  } finally {
    process.exit(0);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Scraper API ready"));

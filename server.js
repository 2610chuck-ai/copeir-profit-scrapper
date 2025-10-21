// server_cors_fixed.js
import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();

// ---------- CORS global ----------
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

let lastResults = { updatedAt: null, items: [] };

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

function parseProfit(rawText) {
  if (!rawText) return null;
  const only = String(rawText).replace(/[^\d,.\-+]/g, "");
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

async function scrapeFollowersProfits() {
  const url = "https://www.bitget.com/de/copy-trading/trader/bfbc477e88b23d51a792/futures-followers";

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1200);

    const rawList = await page.evaluate(() => {
      const fonts = Array.from(document.querySelectorAll('font[dir="auto"][style*="vertical-align"]'));
      return fonts.map(el => el.textContent?.trim() || "").filter(Boolean);
    });

    const profits = rawList.map(t => ({ raw: t, profit: t ? t : null })).slice(0, 7);

    const items = profits.map((p, i) => ({
      name: `Follower ${i + 1}`,
      raw: p.raw,
      profit: parseProfit(p.raw) ?? 0
    }));

    return items;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

app.get("/healthz", (req, res) => res.type("text").send("OK"));
app.get("/api/last-results", (req, res) => res.json(lastResults));
app.options("/api/refresh-now", cors());

app.post("/api/refresh-now", async (req, res) => {
  try {
    const items = await scrapeFollowersProfits();
    lastResults = { updatedAt: new Date().toISOString(), items };
    res.json({ ok: true, updatedAt: lastResults.updatedAt, count: items.length });
  } catch (e) {
    console.error("refresh-now error:", e);
    res.status(500).json({ error: String(e) });
  }
});

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

process.on("SIGTERM", async () => {
  try {
    if (browserPromise) (await browserPromise).close();
  } finally {
    process.exit(0);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Scraper API ready"));

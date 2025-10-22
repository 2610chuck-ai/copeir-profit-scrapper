// server.js
// Node 22, ESM. Braucht: "type": "module" in package.json
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// CORS offen für dein Frontend
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const CONFIG_PATH = path.join(__dirname, "copierprofit.json");

// ---------- Helpers ----------
/** robustes Zahl-Parsing (unterstützt 1.234,56 und 1,234.56) */
function parseNumberFlexible(raw) {
  if (!raw) return null;
  const norm = String(raw).replace(/[^0-9,.\-+]/g, "");
  const lc = norm.lastIndexOf(","), ld = norm.lastIndexOf(".");
  const ls = Math.max(lc, ld);
  let s = norm;
  if (lc !== -1 && ld !== -1) {
    // beide vorhanden -> letzter ist Dezimaltrenner
    s = norm.replace(/[,\.]/g, (m, i) => (i === ls ? "." : ""));
  } else if (lc !== -1) {
    // nur Komma -> Komma ist Dezimaltrenner
    s = norm.replace(/\./g, "").replace(",", ".");
  } else {
    // nur Punkt oder nichts
    s = norm.replace(/,/g, "");
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Browser-Singleton + Mutex ----------
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
        "--no-zygote",
        "--single-process",
      ],
    });
  }
  return browserPromise;
}
let running = false; // einfacher Mutex, 1 Task zur Zeit

// ---------- Cache im Speicher ----------
let LAST = { updatedAt: null, currency: "USDT", items: [] };

// ---------- Health ----------
app.get("/", (_req, res) => res.type("text").send("OK"));
app.get("/api/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// ---------- Einzelscrape (Debug) ----------
app.get("/api/scrape-profit", async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel && String(req.query.sel).trim();
  const txt = req.query.text && String(req.query.text).trim();
  const nth = req.query.nth ? Math.max(1, parseInt(String(req.query.nth), 10)) : null;
  const wantAll = String(req.query.all || "").toLowerCase() === "1";
  if (!url || (!sel && !txt && !wantAll)) {
    return res.status(400).json({ error: "Need url and (sel OR text) or set all=1" });
  }

  let ctx, page;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
    });
    page = await ctx.newPage();
    await page.goto(String(url), { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1500);

    let texts = [];
    if (sel) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        texts = await page.$$eval(sel, (els) =>
          els.map((e) => e.innerText?.trim() || "").filter(Boolean)
        );
      } catch {}
    }
    if (texts.length === 0) {
      texts = await page.evaluate((needle) => {
        function vis(el) {
          const s = getComputedStyle(el);
          return s && s.visibility !== "hidden" && s.display !== "none";
        }
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
      if (parts) for (const p of parts) matches.push({ raw: p, profit: parseNumberFlexible(p) });
    }
    const nums = matches.filter((m) => m.profit !== null);

    if (wantAll) return res.json({ count: nums.length, items: nums });

    const pick = (nth && nums[nth - 1]) || nums[0];
    if (!pick) throw new Error("No number found");
    return res.json({ ...pick, index: nth || 1, total: nums.length });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (ctx) await ctx.close(); } catch {}
  }
});

// ---------- MANUELLES UPDATE: POST /api/refresh-now ----------
app.post("/api/refresh-now", async (_req, res) => {
  if (running) return res.status(429).json({ ok: false, error: "already running" });
  running = true;

  let ctx, page;
  try {
    // Config laden
    const cfgRaw = await fs.readFile(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(cfgRaw);
    const currency = String(cfg.currency || "USDT");
    const list = Array.isArray(cfg.copiers) ? cfg.copiers : [];
    if (!list.length) throw new Error("copier list empty");

    const targetUrl = list[0].sourceUrl; // alle nutzen gleiche URL
    const browser = await getBrowser();
    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
    });
    page = await ctx.newPage();

    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 90000 });
    await sleep(1500);

    // minimal scrollen, weil Bitget gern lazy-loadet
    await page.mouse.wheel(0, 600);
    await sleep(800);

    // pro Follower die Gewinn-Zahl im jeweiligen Zeilen-/Karten-Container finden
    const whoList = list.map((c) => c.who);
    const found = await page.evaluate((names) => {
      function visible(el) {
        const s = getComputedStyle(el);
        return s && s.visibility !== "hidden" && s.display !== "none";
      }
      function containsText(el, text) {
        return el && el.innerText && el.innerText.toLowerCase().includes(text.toLowerCase());
      }
      // Ermittelt eine „Zeile/Karte“ um das Name-Element herum
      function findRowContainer(nameEl) {
        if (!nameEl) return null;
        const selectors = [
          "li", "div[role='row']", "div[role='listitem']", "tr",
          "[class*='list-item']", "[class*='row']", "[class*='card']",
          "[class*='item']", "[class*='list']", "section"
        ];
        let cur = nameEl;
        for (let i = 0; i < 12 && cur; i++) {
          for (const sel of selectors) {
            const c = cur.closest?.(sel);
            if (c && c.contains(nameEl)) return c;
          }
          cur = cur.parentElement;
        }
        return nameEl.parentElement || nameEl;
      }
      // Sucht im Container die grüne/rote Zahl mit Vorzeichen
      function findSignedProfitIn(container) {
        if (!container || !container.querySelectorAll) return null;
        const profitNodes = container.querySelectorAll(
          "span.text-content-trade-buy-text, span.text-content-trade-sell-text, " +
          ".profit, .text-success, .text-danger, .green, .red, .up, .down, [style*='color']"
        );
        for (const el of profitNodes) {
          if (!visible(el)) continue;
          const t = el.textContent?.trim();
          if (t && /[+-]\s*\d/.test(t)) return t;
        }
        return null;
      }

      const out = [];
      for (const name of names) {
        // nur Textblätter durchsuchen => weniger falsche Matches
        const leafNodes = Array.from(document.querySelectorAll("body *")).filter(
          (n) => visible(n) && n.children.length === 0 && n.textContent?.trim()
        );
        const candidates = leafNodes.filter((n) => containsText(n, name));
        if (!candidates.length) {
          out.push({ who: name, raw: null, profitText: null, error: "name not found" });
          continue;
        }
        let row = null;
        for (const cand of candidates) {
          const r = findRowContainer(cand);
          if (r && r !== document.body) { row = r; break; }
        }
        if (!row) {
          out.push({ who: name, raw: null, profitText: null, error: "row not found" });
          continue;
        }
        const profitText = findSignedProfitIn(row);
        if (!profitText) {
          out.push({ who: name, raw: null, profitText: null, error: "profit not found" });
        } else {
          out.push({ who: name, raw: profitText, profitText });
        }
      }
      return out;
    }, whoList);

    // normalisieren & zusammenführen
    const items = list.map((c) => {
      const hit = found.find((f) => f.who === c.who);
      let profit = null, raw = null, error = null;
      if (hit) {
        raw = hit.profitText || hit.raw;
        if (raw) profit = parseNumberFlexible(hit.profitText || hit.raw);
        if (!raw || profit === null) error = hit.error || "parse error";
      } else {
        error = "not scraped";
      }
      return {
        name: c.name,
        who: c.who,
        start: c.start,
        capital: c.capital,
        live: { profit, raw, error }
      };
    });

    LAST = { updatedAt: new Date().toISOString(), currency, items };
    res.json({ ok: true, ...LAST });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (ctx) await ctx.close(); } catch {}
    running = false;
  }
});

// ---------- Cache lesen ----------
app.get("/api/last-results", (_req, res) => {
  res.json(LAST);
});

// ---------- Warmup ----------
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

// ---------- Shutdown ----------
process.on("SIGTERM", async () => {
  try { if (browserPromise) (await browserPromise).close(); }
  finally { process.exit(0); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Scraper API ready on", PORT));
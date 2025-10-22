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
  if (res.req.method === "OPTIONS") return res.sendStatus(200);
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Robuster Browser-Singleton ----------
let browser = null;

async function launchBrowser() {
  try { if (browser) await browser.close(); } catch {}
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  return browser;
}

async function getBrowser() {
  // Wenn keiner läuft -> starten
  if (!browser) return await launchBrowser();

  // Ping: versuche kurz einen Context zu öffnen – wenn das fehlschlägt, relaunch
  try {
    const test = await browser.newContext();
    await test.close();
    return browser;
  } catch {
    return await launchBrowser();
  }
}

/** Öffnet Context+Page und macht bei Fehlern (z. B. "browser closed") einen Relaunch und 1 Retry */
async function openPageWithRetry() {
  try {
    const br = await getBrowser();
    const ctx = await br.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
    });
    const page = await ctx.newPage();
    return { ctx, page };
  } catch (e) {
    // 1x retry nach Relaunch
    await launchBrowser();
    const br = await getBrowser();
    const ctx = await br.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
    });
    const page = await ctx.newPage();
    return { ctx, page };
  }
}

// ---------- Cache im Speicher ----------
let LAST = { updatedAt: null, currency: "USDT", items: [] };

// ---------- Routen ----------
app.get("/", (_req, res) => res.type("text").send("OK"));
app.get("/api/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

// direkter Einzelscrape (Test/Debug)
// GET /api/scrape-profit?url=...&all=1 oder &sel=.../&text=...
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
    ({ ctx, page } = await openPageWithRetry());
    await page.goto(String(url), { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1200);

    // sichtbare Texte einsammeln
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
    try { await page?.close(); } catch {}
    try { await ctx?.close(); } catch {}
  }
});

// --------- MANUELLES UPDATE: POST /api/refresh-now ---------
let running = false; // einfacher Mutex, 1 Task zur Zeit

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

    ({ ctx, page } = await openPageWithRetry());
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 90000 });
    await sleep(1200);

    // minimal scrollen, weil Bitget gern lazy-loadet
    await page.mouse.wheel(0, 400);
    await sleep(600);

    // pro Follower den Gewinn extrahieren
    const whoList = list.map((c) => c.who);
    const found = await page.evaluate((names) => {
      function visible(el) {
        const s = getComputedStyle(el);
        return s && s.visibility !== "hidden" && s.display !== "none";
      }
      function containsText(el, text) {
        return el && el.innerText && el.innerText.toLowerCase().includes(text.toLowerCase());
      }
      function closestContainer(el, depth = 6) {
        let cur = el;
        for (let i = 0; i < depth && cur; i++) {
          if (cur.matches?.("li, div[role='listitem'], .list-item, .card, .row, .cell, .flex, .grid"))
            return cur;
          cur = cur.parentElement;
        }
        return el?.parentElement || el;
      }
      const out = [];
      const numRe = /[-+]?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g;

      for (const name of names) {
        const candidates = Array.from(document.querySelectorAll("body *"))
          .filter((n) => visible(n) && containsText(n, name));
        if (!candidates.length) {
          out.push({ who: name, raw: null, profitText: null, error: "name not found" });
          continue;
        }
        const card = closestContainer(candidates[0]);
        let profitText = null;

        // typische Klassen für die grüne/rote Zahl
        const gainNodes = card.querySelectorAll
          ? card.querySelectorAll(
              "span.text-content-trade-buy-text, span.text-content-trade-sell-text, .profit, .text-success, .green, .up, [style*='color']"
            )
          : [];
        for (const el of gainNodes) {
          const t = el.textContent?.trim();
          if (!t) continue;
          if (!/[+-]\s*\d/.test(t)) continue;
          profitText = t;
          break;
        }
        if (!profitText) {
          const text = card.innerText || "";
          const m = text.match(numRe);
          if (m && m.length) {
            const idx = text.indexOf(m[0]);
            const sign = /-/.test(text.slice(Math.max(0, idx - 3), idx + 1)) ? "-" : "+";
            profitText = sign + m[0];
          }
        }
        if (!profitText) out.push({ who: name, raw: null, profitText: null, error: "profit not found" });
        else out.push({ who: name, raw: profitText, profitText });
      }
      return out;
    }, whoList);

    // normalisieren & mit Stammdaten verheiraten
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
    try { await page?.close(); } catch {}
    try { await ctx?.close(); } catch {}
    running = false;
  }
});

// --------- Cache lesen: GET /api/last-results ---------
app.get("/api/last-results", (_req, res) => {
  res.json(LAST);
});

// ---------- Warmup ----------
(async () => {
  try {
    const br = await getBrowser();
    const ctx = await br.newContext();
    const p = await ctx.newPage();
    await p.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await p.close(); await ctx.close();
    console.log("Warmup done");
  } catch (e) {
    console.log("Warmup skipped:", String(e));
  }
})();

// ---------- Shutdown ----------
process.on("SIGTERM", async () => {
  try { if (browser) await browser.close(); }
  finally { process.exit(0); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Scraper API ready on", PORT));
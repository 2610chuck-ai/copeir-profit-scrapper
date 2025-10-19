import express from 'express';
import { chromium } from 'playwright';

const app = express();

app.get('/api/scrape-profit', async (req, res) => {
  const url = req.query.url;
  const sel = req.query.sel;
  if (!url || !sel) return res.status(400).json({ error: 'Missing url or sel' });

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(String(url), { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector(String(sel), { timeout: 30000 });

    const raw = await page.$eval(String(sel), el => el.innerText.trim());

    // Parse number (supports de-DE/en-US style)
    const normalized = raw.replace(/[^0-9,\.\-]/g, '');
    const lc = normalized.lastIndexOf(','), ld = normalized.lastIndexOf('.');
    const ls = Math.max(lc, ld);
    let num = normalized;
    if (lc !== -1 && ld !== -1) {
      num = normalized.replace(/[,\.]/g, (m,i)=> i===ls ? '.' : '');
    } else {
      if (lc !== -1) num = normalized.replace(/\./g,'').replace(',', '.');
      else num = normalized.replace(/,/g,'');
    }
    const profit = parseFloat(num);

    res.json({ profit: Number.isFinite(profit) ? profit : null, raw });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

app.get('/', (req,res)=> res.type('text').send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('Scraper API ready'));

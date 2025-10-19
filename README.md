# copeir-profit-scrapper[README.md](https://github.com/user-attachments/files/22991341/README.md)
# copy-profit-scraper

Kleine Express-API, die mit Playwright eine Seite rendert und per CSS-Selector
den Gewinn-Text ausliest. Endpoint:

```
GET /api/scrape-profit?url=...&sel=...
```

## Lokal starten
```
npm i
npm start
```

## Deploy bei Render.com
- New > Web Service > GitHub Repo wählen
- Start Command: `npm start`
- Free Plan reicht

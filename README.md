# West Bengal Election Results Dashboard

Live dashboard for West Bengal Assembly results from the Election Commission of India results portal.

## Run

```bash
node server.js
```

Then open:

```text
http://localhost:4173
```

## How It Updates

- The browser refreshes results every 60 seconds.
- The Node server caches ECI fetches for 25 seconds to avoid hammering the portal.
- It discovers the active ECI Assembly results folder from `https://results.eci.gov.in/`.
- It uses West Bengal state code `S25`, reads `partywiseresult-S25.htm`, `statewiseS251.htm` pagination, and `election-json-S25-live.json` when available.

Before ECI exposes the May 2026 result pages, the dashboard shows a waiting state and keeps polling.

## Publish Free

Vercel works well for the free public version because this project includes a serverless `/api/results` proxy.

1. Push this folder to a GitHub repository.
2. Import the repository at `https://vercel.com/new`.
3. Use the default settings. No build command is required.
4. Open the deployed URL.

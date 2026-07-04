# Quasi Tracker

Daily tracker for Korean quasi-drug product permission data from the public data API:

`https://apis.data.go.kr/1471000/QdrgPrdtPrmsnInfoService03/getQdrgPrdtPrmsnInfoInq03`

## Features

- Daily client-side snapshot renewal after 07:00 KST
- Full local search and filtering over the latest snapshot
- Change detection between snapshots
- Detail drawer for ingredients, efficacy, dosage, and cautions
- Vercel serverless proxy so the service key is not exposed in browser code

## Local Setup

Create `.env.local`:

```bash
QDRG_SERVICE_KEY=...
PORT=3000
```

Run:

```bash
npm run dev
```

Then open `http://localhost:3000`.

## Vercel

Set `QDRG_SERVICE_KEY` as a Vercel environment variable for production.

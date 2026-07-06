# Quasi Tracker

Daily tracker for Korean quasi-drug product permission data from the public data API:

`https://apis.data.go.kr/1471000/QdrgPrdtPrmsnInfoService03/getQdrgPrdtPrmsnInfoInq03`

## Features

- Daily central snapshot renewal through GitHub Actions after 07:00 KST
- Full local search and filtering over the latest snapshot
- Monthly baseline change detection with 12 months of fixed baseline retention
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

## Daily Snapshot

The browser no longer refreshes the full public API per device. Instead:

1. GitHub Actions runs every day at 07:10 KST.
2. `scripts/build-snapshot.mjs` fetches the API through the deployed Vercel proxy.
3. The generated `manifest.json`, `snapshot.json`, and monthly `baselines/*.json` files are force-pushed to the `data` branch.
4. The app checks the small manifest first and only downloads the central snapshot when `rowsHash` changes.

## Monthly Baselines

The data branch keeps up to 12 fixed monthly baseline DB files:

```text
snapshot.json
baselines/2026-07.json
baselines/2026-06.json
...
```

On each refresh, the current month baseline is created only if it does not already exist. Older baseline files outside the latest 12 months are omitted from the next generated data branch update. The app compares a selected baseline month against the latest snapshot and lets users filter or export those changes.

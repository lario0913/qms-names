# QMS Names (frontend)

Static site, no build step. Contract: 0x21f5c1A44170F8396b95887b433515fc87898A38 on QMS Testnet (19480).

## Run locally
    npx serve .        (or: python -m http.server 8080)
Open the printed address in a browser with a wallet extension.

## Deploy
Upload this folder to Netlify (drag and drop), Vercel, Cloudflare Pages or GitHub Pages.

## Change things
- Contract address, RPC, confirmations: top of app.js (CFG)
- Colors: CSS variables at the top of styles.css (--bg, --ac, --ok ...)

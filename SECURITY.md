# Security Policy

## Supported versions

SailCommand is a client-only PWA with no backend and no accounts. The only
supported version is the latest deployment at
<https://docgerd.github.io/sail_command/> (built from `main`). Older
service-worker caches self-update on the next online visit.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**[Report a vulnerability](https://github.com/DocGerd/sail_command/security/advisories/new)**
(Security tab → "Report a vulnerability"). Do not open a public issue for
anything exploitable.

You can expect an acknowledgment within 7 days. Coordinated disclosure is
appreciated; there is no bug-bounty program.

## Scope notes

- All user data (saved plans, wind grids, settings) stays in the browser
  (IndexedDB / localStorage). The app makes exactly one class of runtime
  network request beyond same-origin asset fetches: wind forecasts from
  Open-Meteo, called directly from the browser.
- The deployed site is static (GitHub Pages). Supply-chain reports about
  bundled dependencies are in scope; see
  `app/public/THIRD-PARTY-NOTICES.txt` for the inventory.

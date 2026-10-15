# orc-sources

Raw ORC / VPP source captures behind EASY GO!'s own polar tables
(multi-boat spec §P.2, §P.8). Hand-authored: no script writes this directory.
The generator `pipeline/derive_orc_polars.mjs` reads only these files.

| File | Content |
|---|---|
| `orc-ns-tur-santa-anastasia-2026.json` | One ORC NS certificate record, SANTA ANASTASIA (RefNo `04590004MKR`, CRO 1938, Salona 44), BOM stripped, embedded as parsed JSON. |
| `orc-vpp111-salona44-cro2009-polargraph.json` | Jib and Symmetric Spinnaker polar cells (TWS 6/8/10/12/14/16/20) of the Salona 44 polargraph, sail no. CRO 2009, VPP 1.11, parsed with `pdftotext -layout`. Cell tags `b`/`r` mark the `(b)`/`(r)` rows. The best-of table is not committed. |

Envelope: `url`, `retrievedAt`, `responseSha256`, `responseBytes`. For the ORC file
`responseSha256` is the hash of the original response (BOM, all 15 owners'
records); the committed file holds one record, so its own bytes differ. For the
polargraph it is the hash of the source PDF, which is not committed (© ORC 2010).

## Re-fetch protocol

1. `GET` the `url`; for the polargraph fetch the Wayback PDF.
2. Hash the response bytes and compare with `responseSha256` / `responseBytes`.
3. Strip the BOM, select the record by `RefNo`, and commit only that record.
4. Write the JSON with Bash or Python, never a formatter-hooked editor.

## Current-year caveat

`DownRMS` serves current-year certificates only. A re-fetch returns the
then-current certificate, so the hash differs once the record is reissued. The
committed capture is the evidence; `retrievedAt` stays the original capture date.

## Licence basis

Per spec §P.8: the Salona 45 precedent (`a0ba92e`) covers committed derived
tables. These source records go beyond it and ship on the maintainer's
acceptance of that exposure; ORC is asked in parallel. Not a release gate.
The ORC response held other owners' records, two with a third party's phone
number; none is committed.

## Unknowns

- CRO 2009's keel.
- The polargraph's kite area, and whether its "Jib" is the 61.1 m² genoa.
- EASY GO!'s headsail areas, trim, charter loading (donor `Dspl_Sailing`
  10,578 kg incl. 920 kg crew vs 9,300 kg measured), keel, and any certificate
  of its own (OQ-6 open).

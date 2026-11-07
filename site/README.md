# 401(k) Loan Refinance Calculator

A single-page calculator that estimates 401(k) loan refinance options under IRC §72(p) and
Treas. Reg. §1.72(p)-1 Q&A-19 / Q&A-20, following the ARA *Participant Loans Resource Guide* (Ch. 5).

## Options shown
1. **Maximum Amount** – replacement loan ends by the replaced loan's latest permissible term
   (processed date + 5 years, or the residence term), so only the replacement loan is tested
   against the limit. One level payment. (Guide Ex. 15–16, Ex. 18 Option #2)
2. **Maximum Term** – a new 5-year term. If it runs past the latest permissible term, the replaced
   balance is added back (sum-of rule). (Guide Ex. 14, 17, 19)
3. **Longer Term with Step Payments** – two-tranche structure: the replaced balance is repaid by its
   original maturity date, and the new cash runs a full 5 years. (Guide Ex. 18 Option #3, Ex. 20)

## Files
- `index.html` – the page
- `engine.js` – calculation engine (no DOM; can be tested with Node)
- `prime-rate.json` – published prime rate, refreshed on weekdays by `.github/workflows/update-prime-rate.yml`
- `scripts/update-prime.mjs` – pulls FRED series DPRIME

## Deploy
Push to GitHub, then **Settings → Pages → Deploy from branch → main / (root)**.
The prime-rate workflow needs **Settings → Actions → General → Workflow permissions → Read and write**.
It can also be run by hand from the Actions tab.

*Estimates only. Verify with a retirement plan professional.*

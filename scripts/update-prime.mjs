// Fetches the bank prime loan rate (FRED series DPRIME, Federal Reserve H.15) and writes prime-rate.json.
import { writeFileSync, readFileSync } from 'node:fs';

const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DPRIME';
const res = await fetch(url, { headers: { 'User-Agent': 'loan-refinance-calculator (GitHub Actions)' } });
if (!res.ok) throw new Error(`FRED returned ${res.status}`);
const rows = (await res.text()).trim().split(/\r?\n/).slice(1)
  .map(l => l.split(','))
  .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v && v !== '.' && !isNaN(+v));
if (!rows.length) throw new Error('No prime rate data found');
const [date, value] = rows[rows.length - 1];
const out = { rate: +value, date, source: 'Federal Reserve H.15 bank prime loan rate via FRED (DPRIME)' };

let prev = null;
try { prev = JSON.parse(readFileSync('prime-rate.json', 'utf8')); } catch {}
if (prev && prev.rate === out.rate && prev.date === out.date) { console.log('Prime rate unchanged:', out); process.exit(0); }
writeFileSync('prime-rate.json', JSON.stringify(out, null, 2) + '\n');
console.log('Updated prime rate:', out);

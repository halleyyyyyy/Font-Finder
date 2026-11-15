// Quick test from the terminal:  npm run scan -- https://klim.co.nz
import { scanFoundry } from '../lib/scraper.js';
const url = process.argv[2] || 'https://klim.co.nz';
const data = await scanFoundry(url);
console.log(`${data.foundry.name} — ${data.families.length} families`, data.stats);
for (const f of data.families) {
  console.log(`  ${f.name.padEnd(32)} ${String(f.styles.length).padStart(3)} styles  ${f.weightMin}-${f.weightMax}${f.variable ? ' VF' : ''}  ${f.specimenMatched ? '→' : '?'} ${f.specimenUrl}`);
}

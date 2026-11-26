// Gera o engine de adblock embutido (src/assets/adblock-engine.bin).
// Baixa as listas (EasyList + rastreadores) UMA vez e serializa. O app carrega
// esse .bin offline no boot, sem depender de rede nem do proxy.
//
// Rode quando quiser atualizar as listas:  node build/gen-adblock.js

const fs = require('fs');
const path = require('path');
const { FiltersEngine } = require('@ghostery/adblocker');

(async () => {
  console.log('Baixando listas (EasyList + rastreadores)...');
  const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
  const out = path.join(__dirname, '..', 'src', 'assets', 'adblock-engine.bin');
  fs.writeFileSync(out, engine.serialize());
  console.log(`engine salvo: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
})().catch(e => { console.error('falha:', e.message); process.exit(1); });

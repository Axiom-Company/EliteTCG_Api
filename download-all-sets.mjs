import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '/Users/rubendreyer/Desktop/EliteTCG/Server/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SETS = [
  { id: 'me02pt5', tcgdex: 'me02.5', name: 'Ascended Heroes' },
  { id: 'me01', tcgdex: 'me01', name: 'Mega Evolution' },
  { id: 'sv10pt5b', tcgdex: 'sv10.5b', name: 'Black Bolt' },
  { id: 'sv10pt5w', tcgdex: 'sv10.5w', name: 'White Flare' },
  { id: 'sv10', tcgdex: 'sv10', name: 'Destined Rivals' },
  { id: 'sv9', tcgdex: 'sv09', name: 'Journey Together' },
  { id: 'sv8pt5', tcgdex: 'sv08.5', name: 'Prismatic Evolutions' },
  { id: 'sv8', tcgdex: 'sv08', name: 'Surging Sparks' },
  { id: 'sv4pt5', tcgdex: 'sv04.5', name: 'Paldean Fates' },
  { id: 'sv3pt5', tcgdex: 'sv03.5', name: '151' },
  { id: 'sv2', tcgdex: 'sv02', name: 'Paldea Evolved' },
  { id: 'swsh8', tcgdex: 'swsh8', name: 'Fusion Strike' },
  { id: 'swsh7', tcgdex: 'swsh7', name: 'Evolving Skies' },
  { id: 'swsh6', tcgdex: 'swsh6', name: 'Chilling Reign' },
];

async function processSet(set) {
  console.log(`\n═══ ${set.name} (${set.id}) ═══`);

  // Fetch set card list from TCGdex
  const res = await fetch(`https://api.tcgdex.net/v2/en/sets/${set.tcgdex}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) { console.error(`  SKIP: ${res.status}`); return; }
  const setData = await res.json();
  const cards = setData.cards || [];
  console.log(`  ${cards.length} cards`);

  let ok = 0, fail = 0;

  // Batch 20 at a time
  for (let i = 0; i < cards.length; i += 20) {
    const batch = cards.slice(i, i + 20);

    await Promise.all(batch.map(async (card) => {
      // TCGdex gives image base URL per card (e.g. https://assets.tcgdex.net/en/sv/sv09/001)
      const imgUrl = card.image ? `${card.image}/high.png` : null;
      if (!imgUrl) { fail++; return; }

      // Storage path: cards/{ourSetId}/{localId padded}.png
      const num = String(card.localId).padStart(3, '0');
      const storagePath = `cards/${set.id}/${num}.png`;

      try {
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) });
        if (!imgRes.ok) { fail++; return; }
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        if (buffer.length < 500) { fail++; return; }

        const { error } = await supabase.storage
          .from('images')
          .upload(storagePath, buffer, { contentType: 'image/png', upsert: true });

        if (error) { fail++; }
        else { ok++; }
      } catch { fail++; }
    }));

    process.stdout.write(`  ${Math.min(i + 20, cards.length)}/${cards.length} (${ok} ok, ${fail} fail)\r`);
  }

  console.log(`  DONE: ${ok} uploaded, ${fail} failed out of ${cards.length}`);
  return { id: set.id, name: set.name, total: cards.length, ok, fail };
}

console.log('Downloading all set images to Supabase Storage...');
const results = [];
for (const set of SETS) {
  results.push(await processSet(set));
}
console.log('\n\n═══ SUMMARY ═══');
results.forEach(r => r && console.log(`  ${r.name} (${r.id}): ${r.ok}/${r.total} ok, ${r.fail} failed`));
console.log('\nAll done!');

/**
 * Upload Journey Together and YuGiOh images to Supabase Storage
 * Run from EliteTCG_API root: node scripts/upload-journey-together-images.mjs
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const BUCKET = 'images';
const FOLDER = 'products';

// ── Images to upload ──
const IMAGES = [
  {
    source: path.join(ROOT, 'journey-together-booster-1.webp'),
    filename: 'pokemon-journey-together-booster-1.webp',
    slug: 'pokemon-journey-together-booster-display'
  },
  {
    source: path.join(ROOT, 'journey-together-booster-2.webp'), 
    filename: 'pokemon-journey-together-booster-2.webp',
    slug: 'pokemon-journey-together-booster-display'
  },
  {
    source: path.join(ROOT, 'yugioh-25th-anniversary-rarity-collection.webp'),
    filename: 'yugioh-25th-anniversary-rarity-collection.webp',
    slug: 'yugioh-25th-anniversary-rarity-collection-2-box'
  }
];

async function uploadImage({ source, filename, slug }) {
  console.log(`\n📁 Processing: ${filename}`);

  if (!fs.existsSync(source)) {
    console.log(`  ❌ SKIP: Source not found: ${path.basename(source)}`);
    return null;
  }

  // Read file buffer
  const fileBuffer = fs.readFileSync(source);
  console.log(`  📊 File size: ${(fileBuffer.length / 1024).toFixed(0)} KB`);

  // Upload to Supabase Storage
  const storagePath = `${FOLDER}/${filename}`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: 'image/webp',
      upsert: true,
    });

  if (error) {
    console.log(`  ❌ UPLOAD FAILED: ${error.message}`);
    return null;
  }

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
  console.log(`  ✅ Uploaded: ${publicUrl}`);

  return { filename, url: publicUrl, slug };
}

async function main() {
  console.log('🚀 Starting image upload to Supabase...\n');
  
  const results = [];

  for (const img of IMAGES) {
    const result = await uploadImage(img);
    if (result) results.push(result);
  }

  // Group URLs by product slug for SQL generation
  const productImages = {};
  for (const { url, slug } of results) {
    if (!productImages[slug]) productImages[slug] = [];
    productImages[slug].push(url);
  }

  // Print SQL to update product images
  if (Object.keys(productImages).length) {
    console.log('\n🗄️  SQL Commands to run in Supabase:');
    console.log('-- ============================================');
    
    for (const [slug, urls] of Object.entries(productImages)) {
      const imagesArray = `["${urls.join('","')}"]`;
      console.log(`UPDATE products SET images = '${imagesArray}' WHERE slug = '${slug}';`);
    }
    console.log('-- ============================================');
  }

  console.log(`\n🎉 Done! ${results.length}/${IMAGES.length} images uploaded successfully.`);
}

main().catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
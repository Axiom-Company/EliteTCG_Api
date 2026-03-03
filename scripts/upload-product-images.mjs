/**
 * Rename product images, convert to webp, upload to Supabase Storage, delete local files.
 * Run from EliteTCG_API root:  node scripts/upload-product-images.mjs
 *
 * IMPORTANT: Only deletes source files AFTER successful upload.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
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

// ── Source images → target slug names ──
const IMAGES = [
  {
    source: path.join(
      ROOT,
      'https___www.geek-zone.co.za_wp-content_uploads_2025_01_Pokemon_JourneyTogether_01_booster-display_5000x.avif',
    ),
    slug: 'pokemon-journey-together-booster-box',
  },
  {
    source: path.join(ROOT, '41S9hbLW5TL._SL500_.jpg'),
    slug: 'yugioh-25th-anniversary-rarity-collection-2-box',
  },
];

async function processImage({ source, slug }) {
  console.log(`\nProcessing: ${slug}`);

  if (!fs.existsSync(source)) {
    console.log(`  SKIP: Source not found: ${path.basename(source)}`);
    return null;
  }

  // Convert to webp in memory
  const webpBuffer = await sharp(source).webp({ quality: 85 }).toBuffer();
  console.log(`  Converted to webp (${(webpBuffer.length / 1024).toFixed(0)} KB)`);

  // Upload to Supabase Storage
  const storagePath = `${FOLDER}/${slug}.webp`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, webpBuffer, {
      contentType: 'image/webp',
      upsert: true,
    });

  if (error) {
    console.log(`  UPLOAD FAILED: ${error.message}`);
    return null;
  }

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
  console.log(`  Uploaded: ${publicUrl}`);

  // Only delete source AFTER successful upload
  fs.unlinkSync(source);
  console.log(`  Deleted source: ${path.basename(source)}`);

  return { slug, url: publicUrl };
}

async function main() {
  const results = [];

  for (const img of IMAGES) {
    const result = await processImage(img);
    if (result) results.push(result);
  }

  // Print SQL to update product images
  if (results.length) {
    console.log('\n-- ============================================');
    console.log('-- Run this SQL in Supabase to set image URLs:');
    console.log('-- ============================================');
    for (const { slug, url } of results) {
      console.log(`UPDATE products SET images = '["${url}"]' WHERE slug = '${slug}';`);
    }
  }

  console.log(`\nDone. ${results.length}/${IMAGES.length} images uploaded.`);
}

main().catch(console.error);

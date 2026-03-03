import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { supabaseAdmin } = await import('../config/supabase.js');

if (!supabaseAdmin) {
  console.error('FATAL: supabaseAdmin is null. Check SUPABASE_URL and SUPABASE_SERVICE_KEY in server/.env');
  process.exit(1);
}

const BUCKET = 'images';
const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');

async function uploadFile(localPath, storagePath) {
  const buffer = fs.readFileSync(localPath);
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'image/webp',
      upsert: true,
    });

  if (error) {
    throw new Error(`Upload failed for ${storagePath}: ${error.message}`);
  }

  const { data } = supabaseAdmin.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  return data.publicUrl;
}

async function run() {
  const allFiles = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.webp'));
  const productFiles = allFiles.filter(f => f !== 'item_not_found.webp');
  const hasFallback = allFiles.includes('item_not_found.webp');

  console.log(`Found ${allFiles.length} .webp files (${productFiles.length} products, fallback: ${hasFallback ? 'yes' : 'no'})`);

  let uploaded = 0;

  if (hasFallback) {
    const localPath = path.join(UPLOADS_DIR, 'item_not_found.webp');
    const publicUrl = await uploadFile(localPath, 'item_not_found.webp');
    console.log(`[fallback] item_not_found.webp -> ${publicUrl}`);
    uploaded++;
  }

  const urlMap = new Map();

  for (const file of productFiles) {
    const localPath = path.join(UPLOADS_DIR, file);
    const storagePath = `products/${file}`;
    const publicUrl = await uploadFile(localPath, storagePath);
    urlMap.set(`/uploads/${file}`, publicUrl);
    console.log(`[${uploaded + 1}/${productFiles.length + (hasFallback ? 1 : 0)}] ${file} -> ${publicUrl}`);
    uploaded++;
  }

  console.log(`\nUpload phase complete: ${uploaded} files uploaded.`);

  const { data: products, error: fetchError } = await supabaseAdmin
    .from('products')
    .select('id, images');

  if (fetchError) {
    console.error('FATAL: Failed to fetch products:', fetchError.message);
    process.exit(1);
  }

  let productsUpdated = 0;

  for (const product of products) {
    if (!Array.isArray(product.images)) continue;

    const hasLocalPath = product.images.some(img => typeof img === 'string' && img.startsWith('/uploads/'));
    if (!hasLocalPath) continue;

    const newImages = product.images.map(img => {
      if (typeof img === 'string' && urlMap.has(img)) {
        return urlMap.get(img);
      }
      return img;
    });

    const { error: updateError } = await supabaseAdmin
      .from('products')
      .update({ images: newImages })
      .eq('id', product.id);

    if (updateError) {
      console.error(`Failed to update product ${product.id}: ${updateError.message}`);
      continue;
    }

    console.log(`Updated product ${product.id}: ${JSON.stringify(product.images)} -> ${JSON.stringify(newImages)}`);
    productsUpdated++;
  }

  console.log(`\nMigration complete: ${uploaded} files uploaded, ${productsUpdated} products updated.`);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

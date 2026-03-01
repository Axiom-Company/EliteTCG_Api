import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { authenticateToken, requireRole, authenticateCustomer, requireSeller } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

const BUCKET = 'images';

// Use memory storage — files go to Supabase Storage, not local disk
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'), false);
  }
};

// Memory storage - buffer in RAM, no disk writes
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadToSupabase = async (buffer, mimetype, originalname, folder = 'products') => {
  const ext = path.extname(originalname);
  const filename = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(filename, buffer, { contentType: mimetype, upsert: false });

  if (error) throw error;

  const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(filename);
  return { url: urlData.publicUrl, filename };
};

// Upload single image (admin)
router.post('/image', authenticateToken, requireRole('super_admin', 'admin', 'manager'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const { url, filename } = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname);

    res.json({ success: true, url, filename, originalName: req.file.originalname, size: req.file.size });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }

// Upload single image (seller)
router.post('/seller-image', authenticateCustomer, requireSeller, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const { url, filename } = await uploadToSupabase(req.file.buffer, req.file.mimetype, req.file.originalname, 'seller');

    res.json({ success: true, url, filename, originalName: req.file.originalname, size: req.file.size });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }

// Upload multiple images (admin)
router.post('/images', authenticateToken, requireRole('super_admin', 'admin', 'manager'), upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No image files provided' });

    const images = await Promise.all(
      req.files.map(async (file) => {
        const { url, filename } = await uploadToSupabase(file.buffer, file.mimetype, file.originalname);
        return { url, filename, originalName: file.originalname, size: file.size };
      })
    );

    res.json({ success: true, images });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

// Delete image from Supabase Storage
router.delete('/:filename', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { filename } = req.params;
    // filename param may be just the name or include the folder prefix
    const filePath = filename.includes('/') ? filename : `products/${filename}`;

    const { error } = await supabaseAdmin.storage.from(BUCKET).remove([filePath]);
    if (error) throw error;

    res.json({ success: true, message: 'Image deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Error handling for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (error) return res.status(400).json({ error: error.message });
  next();
});

export default router;

import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { authenticateCustomer, requireSeller, authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

const BUCKET = 'images';
const WEBP_QUALITY = 82;

// Memory storage - buffer in RAM
const fileFilter = (_req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpeg, jpg, png, webp)'), false);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// UUID v4 validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function uploadToStorage(buffer, folder) {
  if (!supabaseAdmin) {
    throw new Error('Supabase client is not configured');
  }

  const webpBuffer = await sharp(buffer).webp({ quality: WEBP_QUALITY }).toBuffer();
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, '0');
  const filename = `${timestamp}-${random}.webp`;
  const filePath = `${folder}/${filename}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(filePath, webpBuffer, { contentType: 'image/webp', upsert: false });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(filePath);
  return urlData.publicUrl;
}

/**
 * @openapi
 * /sellers/verification/submit:
 *   post:
 *     tags: [Verification]
 *     summary: Submit verification documents (seller)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [id_document, selfie]
 *             properties:
 *               id_document:
 *                 type: string
 *                 format: binary
 *               selfie:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Documents submitted, status pending
 *       400:
 *         description: Missing required files
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// POST /submit - Submit verification documents (seller only)
router.post('/submit', authenticateCustomer, requireSeller, upload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), async (req, res) => {
  try {
    const idDocumentFile = req.files?.id_document?.[0];
    const selfieFile = req.files?.selfie?.[0];

    if (!idDocumentFile) {
      return res.status(400).json({ error: 'ID document is required' });
    }

    if (!selfieFile) {
      return res.status(400).json({ error: 'Selfie is required' });
    }

    const idDocumentUrl = await uploadToStorage(idDocumentFile.buffer, 'verification');
    const selfieUrl = await uploadToStorage(selfieFile.buffer, 'verification');

    if (supabaseAdmin) {
      const { error } = await supabaseAdmin
        .from('seller_profiles')
        .update({
          id_document_url: idDocumentUrl,
          selfie_url: selfieUrl,
          verification_status: 'pending'
        })
        .eq('id', req.customer.seller_id);

      if (error) {
        console.error('Verification submit error:', error);
        return res.status(500).json({ error: 'Failed to submit verification documents' });
      }
    }

    res.json({
      message: 'Verification documents submitted',
      status: 'pending'
    });
  } catch (error) {
    console.error('Verification submit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /sellers/verification/status:
 *   get:
 *     tags: [Verification]
 *     summary: Get own verification status (seller)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Verification status
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Seller profile not found
 *       500:
 *         description: Server error
 */
// GET /status - Get own verification status (seller only)
router.get('/status', authenticateCustomer, requireSeller, async (req, res) => {
  try {
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_profiles')
        .select('verification_status, is_verified, updated_at')
        .eq('id', req.customer.seller_id)
        .single();

      if (error || !data) {
        console.error('Verification status error:', error);
        return res.status(404).json({ error: 'Seller profile not found' });
      }

      const response = {
        status: data.verification_status,
        is_verified: data.is_verified
      };

      if (data.verification_status !== 'none') {
        response.submitted_at = data.updated_at;
      }

      return res.json(response);
    }

    res.json({
      status: 'none',
      is_verified: false
    });
  } catch (error) {
    console.error('Verification status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /sellers/verification/{sellerId}/approve:
 *   post:
 *     tags: [Verification]
 *     summary: Approve seller verification (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Seller verified
 *       400:
 *         description: Invalid seller ID format
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Server error
 */
// POST /:sellerId/approve - Admin approve verification
router.post('/:sellerId/approve', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { sellerId } = req.params;

    if (!UUID_REGEX.test(sellerId)) {
      return res.status(400).json({ error: 'Invalid seller ID format' });
    }

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_profiles')
        .update({
          is_verified: true,
          verified_at: new Date().toISOString(),
          verification_status: 'approved'
        })
        .eq('id', sellerId)
        .select('id')
        .single();

      if (error || !data) {
        console.error('Verification approve error:', error);
        return res.status(404).json({ error: 'Seller not found' });
      }
    }

    res.json({ message: 'Seller verified successfully' });
  } catch (error) {
    console.error('Verification approve error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /sellers/verification/{sellerId}/reject:
 *   post:
 *     tags: [Verification]
 *     summary: Reject seller verification (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Verification rejected
 *       400:
 *         description: Invalid seller ID or missing reason
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Server error
 */
// POST /:sellerId/reject - Admin reject verification
router.post('/:sellerId/reject', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { sellerId } = req.params;

    if (!UUID_REGEX.test(sellerId)) {
      return res.status(400).json({ error: 'Invalid seller ID format' });
    }

    const { reason } = req.body;

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_profiles')
        .update({
          verification_status: 'rejected',
          is_verified: false
        })
        .eq('id', sellerId)
        .select('id')
        .single();

      if (error || !data) {
        console.error('Verification reject error:', error);
        return res.status(404).json({ error: 'Seller not found' });
      }
    }

    res.json({ message: 'Verification rejected' });
  } catch (error) {
    console.error('Verification reject error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Error handling middleware for multer
router.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  next();
});

export default router;

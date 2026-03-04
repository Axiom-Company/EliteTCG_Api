import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { authenticateCustomer } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

const BUCKET = 'images';
const WEBP_QUALITY = 82;
const VISION_API_URL = 'https://vision.googleapis.com/v1/images:annotate';

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
    fileSize: 10 * 1024 * 1024,
  }
});

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

async function detectFace(imageBuffer) {
  const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!apiKey) {
    return { confidence: 0, error: 'Vision API key not configured' };
  }

  try {
    const base64Image = imageBuffer.toString('base64');

    const response = await fetch(`${VISION_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64Image },
          features: [{ type: 'FACE_DETECTION', maxResults: 5 }]
        }]
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Vision API HTTP error:', response.status, errorBody);
      return { confidence: 0, error: `Vision API returned ${response.status}` };
    }

    const data = await response.json();
    const annotations = data.responses?.[0]?.faceAnnotations;
    const confidence = annotations?.[0]?.detectionConfidence ?? 0;

    return { confidence, error: null };
  } catch (err) {
    console.error('Vision API call failed:', err.message);
    return { confidence: 0, error: err.message };
  }
}

// POST /submit - Submit user identity verification
router.post('/submit', authenticateCustomer, upload.fields([
  { name: 'id_front', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'id_back', maxCount: 1 }
]), async (req, res) => {
  try {
    const idFrontFile = req.files?.id_front?.[0];
    const selfieFile = req.files?.selfie?.[0];
    const idBackFile = req.files?.id_back?.[0];

    if (!idFrontFile) {
      return res.status(400).json({ error: 'ID front image is required' });
    }

    if (!selfieFile) {
      return res.status(400).json({ error: 'Selfie image is required' });
    }

    const idFrontUrl = await uploadToStorage(idFrontFile.buffer, 'user-verification');
    const selfieUrl = await uploadToStorage(selfieFile.buffer, 'user-verification');

    let idBackUrl = null;
    if (idBackFile) {
      idBackUrl = await uploadToStorage(idBackFile.buffer, 'user-verification');
    }

    let status = 'under_review';
    let faceMatchPassed = false;
    let faceMatchConfidence = 0;

    const [selfieResult, idFrontResult] = await Promise.all([
      detectFace(selfieFile.buffer),
      detectFace(idFrontFile.buffer)
    ]);

    if (!selfieResult.error && !idFrontResult.error) {
      if (selfieResult.confidence >= 0.80 && idFrontResult.confidence >= 0.55) {
        status = 'approved';
        faceMatchPassed = true;
        faceMatchConfidence = Math.min(selfieResult.confidence, idFrontResult.confidence);
      } else {
        faceMatchPassed = false;
        faceMatchConfidence = Math.min(selfieResult.confidence, idFrontResult.confidence);
      }
    }

    if (supabaseAdmin) {
      const { error: upsertError } = await supabaseAdmin
        .from('seller_verifications')
        .upsert({
          id: randomUUID(),
          customer_id: req.customer.id,
          status,
          id_front_image: idFrontUrl,
          id_back_image: idBackUrl || null,
          selfie_image: selfieUrl,
          face_match_confidence: faceMatchConfidence,
          face_match_passed: faceMatchPassed,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'customer_id' });

      if (upsertError) {
        console.warn('seller_verifications upsert warning:', upsertError.message);
      }
    }

    if (status === 'approved' && supabaseAdmin) {
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .update({ role: 'verified_seller' })
        .eq('id', req.customer.id);

      if (profileError) {
        console.warn('Profile role update warning:', profileError.message);
      }
    }

    const message = status === 'approved'
      ? 'Identity verified. You are now a Verified Seller.'
      : 'Documents submitted. Under review within 24 hours.';

    res.json({ status, face_match_passed: faceMatchPassed, message });
  } catch (error) {
    console.error('User verification submit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /status - Check user verification status
router.get('/status', authenticateCustomer, async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.json({ status: 'none', is_verified: false });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.customer.id)
      .single();

    if (profileError) {
      console.error('Profile lookup error:', profileError.message);
      return res.status(500).json({ error: 'Server error' });
    }

    if (profile?.role === 'verified_seller') {
      return res.json({ status: 'approved', is_verified: true, role: 'verified_seller' });
    }

    const { data: verification, error: verificationError } = await supabaseAdmin
      .from('seller_verifications')
      .select('status, face_match_passed, created_at')
      .eq('customer_id', req.customer.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (verificationError || !verification) {
      return res.json({ status: 'none', is_verified: false });
    }

    res.json({
      status: verification.status,
      is_verified: false,
      face_match_passed: verification.face_match_passed,
      submitted_at: verification.created_at
    });
  } catch (error) {
    console.error('User verification status error:', error);
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

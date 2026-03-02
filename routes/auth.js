import { Router } from 'express';
import { authenticateSupabaseUser, requireRole } from '../middleware/auth.js';

const router = Router();

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Admin Auth]
 *     summary: Get current admin user
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Admin user profile
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
// Get current admin user (Supabase auth + admin role)
router.get('/me', authenticateSupabaseUser, requireRole('admin'), async (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

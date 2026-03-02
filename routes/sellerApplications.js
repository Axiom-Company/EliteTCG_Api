import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import { mockApplications, mockSellerProfiles } from './sellers.js';
import { sendSellerApplicationApproved, sendSellerApplicationRejected } from '../utils/email.js';

const router = Router();

// All routes require admin authentication
router.use(authenticateToken);
router.use(requireRole('super_admin', 'admin', 'manager'));

/**
 * @openapi
 * /admin/seller-applications:
 *   get:
 *     tags: [Seller Applications]
 *     summary: Get all seller applications (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, rejected]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated list of applications
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get all seller applications
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let applications;
    let total;

    if (supabaseAdmin) {
      let query = supabaseAdmin
        .from('seller_applications')
        .select(`
          *,
          customer:customers(id, email, first_name, last_name, phone)
        `, { count: 'exact' });

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        console.error('Get applications error:', error);
        return res.status(500).json({ error: 'Failed to fetch applications' });
      }

      applications = data;
      total = count;
    } else {
      // Mock data
      let filtered = [...mockApplications];
      if (status) {
        filtered = filtered.filter(a => a.status === status);
      }
      filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      total = filtered.length;
      applications = filtered.slice(offset, offset + limit);
    }

    res.json({
      applications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /admin/seller-applications/{id}:
 *   get:
 *     tags: [Seller Applications]
 *     summary: Get a single application (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Application details with customer and reviewer
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Application not found
 *       500:
 *         description: Server error
 */
// Get single application
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let application;

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_applications')
        .select(`
          *,
          customer:customers(id, email, first_name, last_name, phone, created_at),
          reviewer:admin_users(id, name, email)
        `)
        .eq('id', id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Application not found' });
      }

      application = data;
    } else {
      application = mockApplications.find(a => a.id === id);
      if (!application) {
        return res.status(404).json({ error: 'Application not found' });
      }
    }

    res.json({ application });
  } catch (error) {
    console.error('Get application error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /admin/seller-applications/{id}/approve:
 *   post:
 *     tags: [Seller Applications]
 *     summary: Approve a seller application (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               admin_notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Application approved, seller profile created
 *       400:
 *         description: Application is not pending
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Application not found
 *       500:
 *         description: Server error
 */
// Approve application
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_notes } = req.body;

    let application;

    if (supabaseAdmin) {
      // Get application
      const { data: app, error: appError } = await supabaseAdmin
        .from('seller_applications')
        .select('*')
        .eq('id', id)
        .single();

      if (appError || !app) {
        return res.status(404).json({ error: 'Application not found' });
      }

      if (app.status !== 'pending') {
        return res.status(400).json({ error: 'Application is not pending' });
      }

      // Update application status
      const { error: updateError } = await supabaseAdmin
        .from('seller_applications')
        .update({
          status: 'approved',
          admin_notes,
          reviewed_by: req.user.id,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', id);

      if (updateError) {
        console.error('Update application error:', updateError);
        return res.status(500).json({ error: 'Failed to approve application' });
      }

      // Update customer to be a seller
      const { error: customerError } = await supabaseAdmin
        .from('customers')
        .update({
          is_seller: true,
          seller_verified_at: new Date().toISOString()
        })
        .eq('id', app.customer_id);

      if (customerError) {
        console.error('Update customer error:', customerError);
        // Rollback application status
        await supabaseAdmin
          .from('seller_applications')
          .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
          .eq('id', id);
        return res.status(500).json({ error: 'Failed to update customer' });
      }

      // Create seller profile
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('seller_profiles')
        .insert({
          customer_id: app.customer_id,
          display_name: app.display_name,
          payfast_email: app.payfast_email,
          payfast_merchant_id: app.payfast_merchant_id,
          contact_email: app.payfast_email,
          is_active: true
        })
        .select()
        .single();

      if (profileError) {
        console.error('Create seller profile error:', profileError);
        // Note: At this point the customer is already a seller, may need manual fix
        return res.status(500).json({ error: 'Failed to create seller profile' });
      }

      application = { ...app, status: 'approved' };

      // Send approval email to applicant
      const { data: approvedCustomer } = await supabaseAdmin
        .from('customers')
        .select('email')
        .eq('id', app.customer_id)
        .single();

      if (approvedCustomer?.email) {
        sendSellerApplicationApproved(approvedCustomer.email, app.display_name);
      }

      res.json({
        message: 'Application approved successfully',
        application,
        seller_profile: profile
      });
    } else {
      // Mock approval
      const index = mockApplications.findIndex(a => a.id === id);
      if (index === -1) {
        return res.status(404).json({ error: 'Application not found' });
      }

      if (mockApplications[index].status !== 'pending') {
        return res.status(400).json({ error: 'Application is not pending' });
      }

      mockApplications[index].status = 'approved';
      mockApplications[index].admin_notes = admin_notes;
      mockApplications[index].reviewed_at = new Date().toISOString();

      // Create mock seller profile
      const profile = {
        id: `mock-seller-${Date.now()}`,
        customer_id: mockApplications[index].customer_id,
        display_name: mockApplications[index].display_name,
        payfast_email: mockApplications[index].payfast_email,
        contact_email: mockApplications[index].payfast_email,
        is_active: true,
        total_listings: 0,
        active_listings: 0,
        total_sales: 0,
        rating: 0,
        review_count: 0,
        created_at: new Date().toISOString()
      };
      mockSellerProfiles.push(profile);

      res.json({
        message: 'Application approved successfully',
        application: mockApplications[index],
        seller_profile: profile
      });
    }
  } catch (error) {
    console.error('Approve application error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /admin/seller-applications/{id}/reject:
 *   post:
 *     tags: [Seller Applications]
 *     summary: Reject a seller application (admin)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rejection_reason]
 *             properties:
 *               rejection_reason:
 *                 type: string
 *               admin_notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Application rejected
 *       400:
 *         description: Application is not pending or missing reason
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Application not found
 *       500:
 *         description: Server error
 */
// Reject application
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejection_reason, admin_notes } = req.body;

    if (!rejection_reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    let application;

    if (supabaseAdmin) {
      // Get application
      const { data: app, error: appError } = await supabaseAdmin
        .from('seller_applications')
        .select('*')
        .eq('id', id)
        .single();

      if (appError || !app) {
        return res.status(404).json({ error: 'Application not found' });
      }

      if (app.status !== 'pending') {
        return res.status(400).json({ error: 'Application is not pending' });
      }

      // Update application status
      const { data, error } = await supabaseAdmin
        .from('seller_applications')
        .update({
          status: 'rejected',
          rejection_reason,
          admin_notes,
          reviewed_by: req.user.id,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Reject application error:', error);
        return res.status(500).json({ error: 'Failed to reject application' });
      }

      application = data;

      // Send rejection email to applicant
      const { data: rejectedCustomer } = await supabaseAdmin
        .from('customers')
        .select('email')
        .eq('id', app.customer_id)
        .single();

      if (rejectedCustomer?.email) {
        sendSellerApplicationRejected(rejectedCustomer.email, app.display_name, rejection_reason);
      }
    } else {
      // Mock rejection
      const index = mockApplications.findIndex(a => a.id === id);
      if (index === -1) {
        return res.status(404).json({ error: 'Application not found' });
      }

      if (mockApplications[index].status !== 'pending') {
        return res.status(400).json({ error: 'Application is not pending' });
      }

      mockApplications[index].status = 'rejected';
      mockApplications[index].rejection_reason = rejection_reason;
      mockApplications[index].admin_notes = admin_notes;
      mockApplications[index].reviewed_at = new Date().toISOString();

      application = mockApplications[index];
    }

    res.json({
      message: 'Application rejected',
      application
    });
  } catch (error) {
    console.error('Reject application error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @openapi
 * /admin/seller-applications/stats/overview:
 *   get:
 *     tags: [Seller Applications]
 *     summary: Get application stats overview (admin)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Count of pending, approved, rejected applications
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
// Get stats
router.get('/stats/overview', async (req, res) => {
  try {
    let stats = {
      pending: 0,
      approved: 0,
      rejected: 0,
      total: 0
    };

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('seller_applications')
        .select('status');

      if (!error && data) {
        stats.total = data.length;
        stats.pending = data.filter(a => a.status === 'pending').length;
        stats.approved = data.filter(a => a.status === 'approved').length;
        stats.rejected = data.filter(a => a.status === 'rejected').length;
      }
    } else {
      stats.total = mockApplications.length;
      stats.pending = mockApplications.filter(a => a.status === 'pending').length;
      stats.approved = mockApplications.filter(a => a.status === 'approved').length;
      stats.rejected = mockApplications.filter(a => a.status === 'rejected').length;
    }

    res.json({ stats });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

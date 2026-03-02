import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'EliteTCG API',
      version: '1.0.0',
      description: 'Products, categories, sets, customer auth, marketplace, orders, and admin for Elite TCG',
    },
    servers: [
      { url: '/api', description: 'API base' }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase access token (customer) or custom JWT (admin)',
        },
      },
    },
    tags: [
      { name: 'Health', description: 'Health check' },
      { name: 'Customer Auth', description: 'Registration, login, profile (Supabase Auth)' },
      { name: 'Admin Auth', description: 'Admin login and profile' },
      { name: 'Products', description: 'Product catalog' },
      { name: 'Sets', description: 'TCG card sets' },
      { name: 'Categories', description: 'Product categories' },
      { name: 'Preorders', description: 'Pre-order products' },
      { name: 'Discounts', description: 'Discount codes' },
      { name: 'Marketplace', description: 'Seller listings and marketplace' },
      { name: 'Orders', description: 'Order management' },
      { name: 'Sellers', description: 'Seller profiles' },
      { name: 'Reviews', description: 'Marketplace reviews' },
      { name: 'Uploads', description: 'Image uploads' },
      { name: 'Config', description: 'Site configuration' },
      { name: 'Shipping', description: 'Courier Guy shipping' },
      { name: 'Checkout', description: 'Store checkout (PayFast)' },
      { name: 'PayFast', description: 'PayFast webhooks' },
      { name: 'Seller Applications', description: 'Admin management of seller applications' },
      { name: 'Seller Analytics', description: 'Seller performance analytics' },
      { name: 'Verification', description: 'Seller identity verification' },
      { name: 'Promotions', description: 'Listing promotion tiers and purchases' },
      { name: 'Admin API', description: 'Admin dashboard, order management' },
    ],
  },
  apis: ['./routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);

# EliteTCG API

Backend API server for the EliteTCG trading card game marketplace application.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```

3. Update the `.env` file with your configuration values.

4. Start the server:
   ```bash
   # Development
   npm run dev

   # Production
   npm start
   ```

## Environment Variables

See `.env.example` for required environment variables including:

- **Supabase Configuration**: Database and auth
- **JWT Configuration**: Token signing and expiration
- **PayFast Integration**: Payment processing
- **ZeptoMail**: Transactional emails
- **Server Configuration**: Port and environment settings

## API Endpoints

The server provides RESTful API endpoints for:

- User authentication and authorization
- Product management (TCG cards, sealed products)
- Marketplace functionality
- Order processing and payment integration
- Admin dashboard functionality

## Deployment

This API can be deployed as a standalone Node.js application or as serverless functions on platforms like Vercel.

The `vercel.json` configuration is included for Vercel deployments.# EliteTCG_Api

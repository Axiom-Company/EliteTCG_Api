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

This API is designed for deployment on Railway as a standalone Node.js application.

### Railway Deployment

1. Connect your repository to Railway
2. Set environment variables in Railway dashboard:
   - Copy all variables from `.env.example`
   - Update with production values
3. Railway will automatically deploy using the `nixpacks.toml` configuration

The `nixpacks.toml` file configures Railway to:
- Use Node.js 20
- Run `npm start` to start the server
- Set production environment# EliteTCG_Api

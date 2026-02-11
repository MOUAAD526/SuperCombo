# Domain Availability Setup Guide

## Overview
The SuperCombinator tool includes a domain availability checking feature. By default, it runs in **Mock Mode**, simulating checks without needing an API key. To use real data, you must configure a domain provider API.

## Modes

### 1. Mock Mode (Default)
- **Status**: Active by default.
- **Behavior**: Returns random availability and prices.
- **Purpose**: Testing UI and flow without costs or API limits.
- **Configuration**: No setup required.

### 2. Real Provider Mode
- **Status**: Requires configuration.
- **Provider**: Currently set up for generic integration (requires implementation in `netlify/functions/check-domain.js`).

## Configuration Steps

### 1. Get an API Key
Obtain an API key from your preferred domain registrar (e.g., Namecheap, GoDaddy, Dynadot).

### 2. Set Environment Variables
In your Netlify dashboard or `.env` file (for local development):
```bash
DOMAIN_PROVIDER_API_KEY=your_api_key_here
DOMAIN_PROVIDER_API_URL=https://api.provider.com/v1/domains/
```

### 3. Update Backend Logic
Open `netlify/functions/check-domain.js` and uncomment/modify the `checkRealDomain` function to match your provider's API response format.

Example for a generic provider:
```javascript
async function checkRealDomain(domain, apiKey) {
    const response = await fetch(`https://api.provider.com/v1/domains/${domain}`, { 
        headers: { 'Authorization': `Bearer ${apiKey}` } 
    });
    const data = await response.json();
    
    return {
        domain: domain,
        available: data.is_available,
        price: data.price,
        currency: 'USD',
        buyUrl: data.registration_url
    };
}
```

## Troubleshooting
- **CORS Errors**: Ensure your Netlify Function headers used `Access-Control-Allow-Origin: *`.
- **Timeouts**: Netlify Functions have a 10s execution limit (default). The frontend limits concurrency to 5 requests to avoid hitting this limit or rate limits.

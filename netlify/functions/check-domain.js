/**
 * Netlify Function: Check Domain Availability
 * 
 * Checks availability and price for a given domain.
 * Supports "mock" mode (no API key) and "real" mode (with API key).
 * 
 * Usage:
 * POST /api/check
 * Body: { "domain": "example.com" }
 */

const fetch = require('node-fetch');

// Configuration
const MOCK_MODE_DELAY = 1000; // ms to simulate network delay
const MOCK_AVAILABILITY_RATE = 0.3; // 30% chance of being available in mock mode

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { domain } = JSON.parse(event.body);

        if (!domain) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Domain is required' })
            };
        }

        // Check for API key (Simulated for now, would be process.env.DOMAIN_API_KEY)
        const apiKey = process.env.DOMAIN_API_KEY;
        const useRealProvider = !!apiKey;

        let result;

        if (useRealProvider) {
            // Real Provider Implementation (Placeholder for now)
            // You would implement the specific logic for Namecheap, GoDaddy, etc. here
            // For now, fall back to mock to ensure it works without a key
            result = await checkMockDomain(domain);
            // result = await checkRealDomain(domain, apiKey); 
        } else {
            result = await checkMockDomain(domain);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Check failed:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
        };
    }
};

/**
 * Mock Domain Checker
 * Simulates checking availability with random results
 */
async function checkMockDomain(domain) {
    // Simulate delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * MOCK_MODE_DELAY));

    const isAvailable = Math.random() < MOCK_AVAILABILITY_RATE;
    const tld = domain.split('.').pop();

    // Generate realistic-looking price
    let price = 10.99;
    if (tld === 'io') price = 39.99;
    if (tld === 'ai') price = 79.99;

    // Randomly vary price slightly
    price = price + (Math.random() * 2 - 1);
    price = Math.round(price * 100) / 100;

    return {
        domain: domain,
        available: isAvailable,
        price: isAvailable ? price : null,
        currency: 'USD',
        premium: false, // In mock mode, assume standard
        registrar: 'Namecheap', // Default suggestion
        buyUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
        checkedAt: new Date().toISOString(),
        method: 'mock'
    };
}

/**
 * Real Domain Checker (Template)
 * Implement specific provider logic here
 */
async function checkRealDomain(domain, apiKey) {
    // Example for a generic provider
    // const response = await fetch(`https://api.provider.com/v1/domains/${domain}`, { 
    //     headers: { 'Authorization': `Bearer ${apiKey}` } 
    // });
    // const data = await response.json();
    // return {
    //     domain: data.domain,
    //     available: data.available,
    //     price: data.price,
    //     ...
    // };
    throw new Error("Real provider not implemented yet");
}

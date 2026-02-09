/**
 * Netlify Function: Protected Winners Endpoint
 * 
 * Returns winners list ONLY for authenticated users.
 * Validates JWT from Netlify Identity.
 * Optionally restricts to ALLOWED_EMAILS env var.
 * 
 * SETUP REQUIRED:
 * 1. Enable Netlify Identity in dashboard
 * 2. Set Registration to "Invite only"
 * 3. Add ALLOWED_EMAILS env var (comma-separated emails)
 * 4. Invite authorized users
 */

// ════════════════════════════════════════════════════
// SERVER-SIDE WINNERS DATA (NOT exposed to client)
// Add your winners here - they are only returned after auth
// ════════════════════════════════════════════════════
const WINNERS = [
    // Example entries - replace with your actual winners
    { domain: "trustflow.com", category: "Finance", status: "Want", price: "$5000", notes: "Great brandable", date: "2025-01-15" },
    { domain: "payverify.com", category: "Payments", status: "Watching", price: "", notes: "Monitor auction", date: "2025-01-20" },
    // Add more winners here...
];

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Only allow GET
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    // ════════════════════════════════════════════════════
    // AUTHENTICATION CHECK
    // ════════════════════════════════════════════════════
    
    // Netlify Identity provides user info in context.clientContext
    const { user } = context.clientContext || {};

    if (!user) {
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ 
                error: 'Unauthorized',
                message: 'Please log in to view winners'
            })
        };
    }

    // Get user email from token
    const userEmail = user.email || '';

    // ════════════════════════════════════════════════════
    // OPTIONAL: Email Whitelist Check
    // Set ALLOWED_EMAILS env var in Netlify dashboard
    // Format: "email1@example.com,email2@example.com"
    // ════════════════════════════════════════════════════
    
    const allowedEmailsEnv = process.env.ALLOWED_EMAILS || '';
    
    if (allowedEmailsEnv) {
        const allowedEmails = allowedEmailsEnv
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(e => e);

        if (allowedEmails.length > 0 && !allowedEmails.includes(userEmail.toLowerCase())) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ 
                    error: 'Forbidden',
                    message: 'Your email is not authorized to view winners'
                })
            };
        }
    }

    // ════════════════════════════════════════════════════
    // SUCCESS: Return winners data
    // ════════════════════════════════════════════════════
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            user: userEmail,
            count: WINNERS.length,
            winners: WINNERS
        })
    };
};

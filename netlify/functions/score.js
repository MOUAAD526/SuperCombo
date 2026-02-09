// Netlify Function: AI Domain Scoring (with Multi-Preset Support)
// POST /.netlify/functions/score
// Body: { domains: [...], preset: "lenders|..." } OR
// Body: { domains: [...], presetIds: ["id1",...], presets: [{...}] } for multi-preset

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_DOMAINS = 120;
const MIN_DOMAINS = 1;
const MAX_PRESETS = 6;
const MIN_PRESETS = 1;

// Legacy preset-specific context (backward compatible)
const PRESET_CONTEXT = {
    lenders: 'The target buyer is a lending company, mortgage provider, or fintech lender. Value domains that convey trust, financial stability, and professional lending services.',
    payments: 'The target buyer is a payments company, payment processor, or fintech payments provider. Value domains that convey speed, security, seamless transactions.',
    ads: 'The target buyer is an advertising/marketing company, ad-tech platform, or digital marketing agency. Value domains that convey reach, performance, and marketing power.',
    brandable: 'The target buyer is any startup or company seeking a memorable, versatile brand name. Value short, catchy, easy-to-remember names with broad appeal.'
};

// Single-preset scoring prompt (legacy)
const SCORING_PROMPT = `You are an expert domain name appraiser. Score each domain for resale value and brandability.

SCORING RUBRIC (total 0-10):
- Brandability (0-3.5): Short, clean, "company name" feel. Premium if 6-10 chars, one or two syllables.
- Pronunciation (0-2): One obvious way to say it aloud. No ambiguity.
- Spelling (0-1.5): One obvious way to spell it. No confusion with homophones.
- Native meaning (0-1): No weird, negative, or embarrassing connotations in English.
- Buyer intent (0-2): Clear fit for the target niche described below.

PENALTIES (subtract from total):
- Contains hyphens or numbers: -2
- Awkward consonant clusters (e.g., "xkcd", "bdfg"): -1
- Spam/scam/compliance red flags (e.g., "guarantee", "instant", "free"): -1 to -3

BUCKETS:
- FAST-FLIP: Score >= 7 (high resale potential, move quickly)
- HOLD: Score 4-6.9 (decent value, may need right buyer)
- PASS: Score < 4 (not worth pursuing)

OUTPUT FORMAT:
Return ONLY a valid JSON array with no extra text. Each element:
{"domain": "example.com", "score": 7.5, "bucket": "FAST-FLIP", "reason": "Short, memorable, clear pronunciation", "use_case": "B2B fintech"}

TARGET NICHE CONTEXT:
{{PRESET_CONTEXT}}

DOMAINS TO SCORE:
{{DOMAINS}}`;

// Multi-preset scoring prompt
const MULTI_PRESET_PROMPT = `You are an expert domain name appraiser. Score each domain against MULTIPLE buyer personas/presets.

For each domain, evaluate it from each persona's perspective using their specific weights and preferences.

SCORING RUBRIC (adjusted by preset weights, total 0-10):
- Brandability: Short, clean, "company name" feel
- Pronunciation: One obvious way to say it aloud
- Spelling: One obvious way to spell it
- Native meaning: No weird or negative connotations
- Buyer intent: Fit for the specific persona's niche

PENALTIES:
- Hyphens or numbers: -2
- Awkward consonant clusters: -1
- Spam/scam red flags: -1 to -3

BUCKETS (per preset):
- FAST-FLIP: Score >= 7
- HOLD: Score 4-6.9
- PASS: Score < 4

OUTPUT FORMAT:
Return ONLY a valid JSON array. Each element:
{
  "domain": "example.com",
  "resultsByPreset": {
    "PRESET_ID_1": {"score": 7.5, "bucket": "FAST-FLIP", "reason": "...", "use_case": "..."},
    "PRESET_ID_2": {"score": 6.0, "bucket": "HOLD", "reason": "...", "use_case": "..."}
  }
}

BUYER PERSONAS:
{{PERSONAS}}

DOMAINS TO SCORE:
{{DOMAINS}}`;

exports.handler = async (event) => {
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
        const body = JSON.parse(event.body);
        const { domains, preset, presetIds, presets } = body;

        // Validate domains
        if (!Array.isArray(domains) || domains.length < MIN_DOMAINS) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing or empty domains array' })
            };
        }

        if (domains.length > MAX_DOMAINS) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: `Too many domains. Maximum ${MAX_DOMAINS} per request. Got ${domains.length}.`
                })
            };
        }

        // Check API key
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'API key not configured' })
            };
        }

        // Detect multi-preset mode
        const isMultiPreset = Array.isArray(presetIds) && presetIds.length > 0;

        if (isMultiPreset) {
            // Multi-preset scoring
            return await handleMultiPresetScoring(domains, presetIds, presets, apiKey, headers);
        } else {
            // Legacy single-preset scoring
            return await handleSinglePresetScoring(domains, preset, apiKey, headers);
        }

    } catch (error) {
        console.error('Function error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
        };
    }
};

// Legacy single-preset scoring
async function handleSinglePresetScoring(domains, preset, apiKey, headers) {
    const presetContext = PRESET_CONTEXT[preset] || PRESET_CONTEXT.brandable;

    const prompt = SCORING_PROMPT
        .replace('{{PRESET_CONTEXT}}', presetContext)
        .replace('{{DOMAINS}}', domains.join('\n'));

    const response = await fetchWithRetry(OPENAI_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are an expert domain name appraiser. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 4000
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI API error:', errorText);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'AI service error', details: errorText })
        };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Empty response from AI' })
        };
    }

    const scores = parseJsonResponse(content);
    if (!scores) {
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Failed to parse AI response', raw: content })
        };
    }

    const validatedScores = scores.map(s => ({
        domain: String(s.domain || ''),
        score: Math.min(10, Math.max(0, parseFloat(s.score) || 0)),
        bucket: ['FAST-FLIP', 'HOLD', 'PASS'].includes(s.bucket) ? s.bucket : 'PASS',
        reason: String(s.reason || '').slice(0, 200),
        use_case: String(s.use_case || '').slice(0, 50)
    }));

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            count: validatedScores.length,
            scores: validatedScores
        })
    };
}

// Multi-preset scoring
async function handleMultiPresetScoring(domains, presetIds, presets, apiKey, headers) {
    // Validate preset count
    if (presetIds.length < MIN_PRESETS || presetIds.length > MAX_PRESETS) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: `Invalid preset count. Must be ${MIN_PRESETS}-${MAX_PRESETS}. Got ${presetIds.length}.`
            })
        };
    }

    // Build preset map
    const presetMap = {};
    for (const p of (presets || [])) {
        if (p && p.id) presetMap[p.id] = p;
    }

    // Build personas description for prompt
    const personas = presetIds.map((id, i) => {
        const p = presetMap[id] || { name: `Preset ${i + 1}`, description: 'General brandable domains' };
        const w = p.weights || {};
        const c = p.constraints || {};
        const banned = (p.bannedSubstrings || []).slice(0, 5).join(', ');
        const prefixes = (p.recommendedPrefixes || []).slice(0, 3).join(', ');
        const suffixes = (p.recommendedSuffixes || []).slice(0, 3).join(', ');

        return `${i + 1}) ID: "${id}" - ${p.name}
   Description: ${p.description || 'Brandable domains'}
   Max length: ${c.maxLen || 12}
   Weights: brandability=${w.brandability || 3.5}, pronunciation=${w.pronunciation || 2}, spelling=${w.spelling || 1.5}, meaning=${w.nativeMeaning || 1}, buyerIntent=${w.buyerIntent || 2}
   ${banned ? `Avoid: ${banned}` : ''}
   ${prefixes ? `Prefer prefixes: ${prefixes}` : ''}
   ${suffixes ? `Prefer suffixes: ${suffixes}` : ''}
   ${p.notes ? `Notes: ${p.notes}` : ''}`;
    }).join('\n\n');

    const prompt = MULTI_PRESET_PROMPT
        .replace('{{PERSONAS}}', personas)
        .replace('{{DOMAINS}}', domains.join('\n'));

    const response = await fetchWithRetry(OPENAI_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are an expert domain appraiser. Score domains against multiple buyer personas. Return ONLY valid JSON array.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 8000 // More tokens for multi-preset
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI API error:', errorText);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'AI service error', details: errorText })
        };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Empty response from AI' })
        };
    }

    const rawResults = parseJsonResponse(content);
    if (!rawResults) {
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Failed to parse AI response', raw: content })
        };
    }

    // Process multi-preset results
    const processedResults = rawResults.map(r => {
        const domain = String(r.domain || '').replace('.com', '').toLowerCase();
        const resultsByPreset = r.resultsByPreset || {};

        // Compute cross-fit metrics
        let bestScore = 0;
        let bestPresetId = '';
        let bestBucket = 'PASS';
        let bestReason = '';
        let bestUseCase = '';
        const scoreByPreset = {};
        const scores = [];

        for (const pid of presetIds) {
            const result = resultsByPreset[pid] || {};
            const score = Math.min(10, Math.max(0, parseFloat(result.score) || 0));
            scoreByPreset[pid] = score;
            scores.push(score);

            if (score > bestScore) {
                bestScore = score;
                bestPresetId = pid;
                bestBucket = ['FAST-FLIP', 'HOLD', 'PASS'].includes(result.bucket) ? result.bucket : 'PASS';
                bestReason = String(result.reason || '').slice(0, 200);
                bestUseCase = String(result.use_case || '').slice(0, 50);
            }
        }

        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const maxScore = bestScore;

        // Determine final bucket based on best score
        let finalBucket;
        if (bestScore >= 8.0) {
            finalBucket = 'FAST-FLIP';
        } else if (bestScore >= 7.0) {
            finalBucket = bestBucket === 'FAST-FLIP' ? 'FAST-FLIP' : 'HOLD';
        } else if (bestScore >= 4.0) {
            finalBucket = 'HOLD';
        } else {
            finalBucket = 'PASS';
        }

        return {
            domain,
            bestPresetId,
            bestPresetName: presetMap[bestPresetId]?.name || bestPresetId,
            bestScore: Math.round(bestScore * 10) / 10,
            avgScore: Math.round(avgScore * 10) / 10,
            maxScore: Math.round(maxScore * 10) / 10,
            bucket: finalBucket,
            reason: bestReason,
            use_case: bestUseCase,
            scoreByPreset
        };
    });

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            count: processedResults.length,
            multiPreset: true,
            presetIds,
            scores: processedResults
        })
    };
}

// Parse JSON response (handles markdown code blocks)
function parseJsonResponse(content) {
    try {
        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
        }
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('JSON parse error:', e, 'Content:', content);
        return null;
    }
}

// Fetch with retry logic
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok || response.status < 500) {
                return response;
            }
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, delay * (i + 1)));
            }
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(r => setTimeout(r, delay * (i + 1)));
        }
    }
    throw new Error('Max retries exceeded');
}

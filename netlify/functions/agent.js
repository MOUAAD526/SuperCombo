// Netlify Function: AI Agent Pipeline (with Multi-Preset Support)
// POST /.netlify/functions/agent
// Full pipeline: Generate + Filter + Score (single or multi-preset)

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_CANDIDATES = 10000;
const MAX_TOPK = 300;
const BATCH_SIZE = 80; // Reduced for multi-preset to fit more output
const MAX_PRESETS = 6;

// Single-preset scoring prompt
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
- Trademark-like words: -2 or PASS

BUCKETS:
- FAST-FLIP: Score >= 7 (high resale potential, move quickly)
- HOLD: Score 4-6.9 (decent value, may need right buyer)
- PASS: Score < 4 (not worth pursuing)

OUTPUT FORMAT:
Return ONLY a valid JSON array with no extra text. Each element:
{"domain": "example.com", "score": 7.5, "bucket": "FAST-FLIP", "reason": "Short, memorable, clear pronunciation", "use_case": "B2B fintech", "templateUsed": "A+B"}`;

// Multi-preset scoring prompt
const MULTI_PRESET_PROMPT = `You are an expert domain name appraiser. Score each domain against MULTIPLE buyer personas.

SCORING RUBRIC (adjusted by preset weights, total 0-10):
- Brandability: Short, clean, "company name" feel
- Pronunciation: One obvious way to say it
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
  "templateUsed": "A+B",
  "resultsByPreset": {
    "PRESET_ID_1": {"score": 7.5, "bucket": "FAST-FLIP", "reason": "...", "use_case": "..."},
    "PRESET_ID_2": {"score": 6.0, "bucket": "HOLD", "reason": "...", "use_case": "..."}
  }
}

BUYER PERSONAS:
{{PERSONAS}}

DOMAINS TO SCORE:
{{DOMAINS}}`;

const MODE_CONTEXT = {
    lenders: 'Target: lending companies, mortgage providers, fintech lenders. Value trust, stability, professional lending.',
    payments: 'Target: payment processors, fintech payments. Value speed, security, seamless transactions.',
    ads: 'Target: advertising, ad-tech, digital marketing. Value reach, performance, marketing power.',
    brandable: 'Target: any startup seeking memorable brand. Value short, catchy, versatile names.'
};

// Ugly cluster patterns to avoid
const UGLY_CLUSTERS = /([bcdfghjklmnpqrstvwxz]{4,})|([aeiou]{4,})|(xx|zz|qq|ww|vv)/i;

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const { task, packs, multipliers, templates, constraints, mode, topK, presetIds, presets } = body;

        if (task !== 'generate_and_score') {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid task' }) };
        }

        const limitedTopK = Math.min(topK || 100, MAX_TOPK);
        const isMultiPreset = Array.isArray(presetIds) && presetIds.length > 0;

        // Validate multi-preset
        if (isMultiPreset && (presetIds.length < 1 || presetIds.length > MAX_PRESETS)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: `Invalid preset count. Must be 1-${MAX_PRESETS}.` })
            };
        }

        // Step 1: Generate combinations
        const candidates = generateCombinations(packs, multipliers, templates, constraints);

        if (candidates.length > MAX_CANDIDATES) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: `Too many candidates (${candidates.length}). Maximum ${MAX_CANDIDATES}. Please tighten your filters.`
                })
            };
        }

        if (candidates.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, results: [], count: 0, multiPreset: isMultiPreset })
            };
        }

        // Step 2: Score in batches
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
        }

        const allScores = [];
        const batchSize = isMultiPreset ? Math.min(60, BATCH_SIZE) : BATCH_SIZE; // Smaller batches for multi-preset
        const batches = chunkArray(candidates, batchSize);

        // Build preset map for multi-preset
        const presetMap = {};
        if (isMultiPreset) {
            for (const p of (presets || [])) {
                if (p && p.id) presetMap[p.id] = p;
            }
        }

        for (const batch of batches) {
            let scores;
            if (isMultiPreset) {
                scores = await scoreMultiPresetBatch(batch, presetIds, presetMap, apiKey);
            } else {
                scores = await scoreSingleBatch(batch, mode, apiKey);
            }
            allScores.push(...scores);
        }

        // Step 3: Sort and return topK
        if (isMultiPreset) {
            // Sort by bestScore desc, then avgScore desc
            allScores.sort((a, b) => {
                if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
                return b.avgScore - a.avgScore;
            });
        } else {
            allScores.sort((a, b) => b.score - a.score);
        }

        const results = allScores.slice(0, limitedTopK);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                count: results.length,
                totalGenerated: candidates.length,
                multiPreset: isMultiPreset,
                presetIds: isMultiPreset ? presetIds : undefined,
                results
            })
        };

    } catch (error) {
        console.error('Agent error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
        };
    }
};

function generateCombinations(packs, multipliers, templates, constraints) {
    const { A = [], B = [], C = [] } = packs || {};
    const { prefixes = [], suffixes = [] } = multipliers || {};
    const maxLen = constraints?.maxLen || 12;
    const noHyphens = constraints?.noHyphens !== false;
    const noNumbers = constraints?.noNumbers !== false;
    const banned = constraints?.banned || [];
    const avoidUglyClusters = constraints?.avoidUglyClusters !== false;

    const results = new Set();

    for (const template of templates || ['A+B']) {
        const combos = applyTemplate(template, A, B, C, prefixes, suffixes);
        for (const combo of combos) {
            results.add(JSON.stringify(combo));
        }
    }

    const candidates = [];
    for (const json of results) {
        const { domain, template, sources } = JSON.parse(json);
        const normalized = domain.toLowerCase().replace(/[^a-z0-9-]/g, '');

        if (!normalized) continue;
        if (normalized.length > maxLen) continue;
        if (noHyphens && normalized.includes('-')) continue;
        if (noNumbers && /\d/.test(normalized)) continue;
        if (avoidUglyClusters && UGLY_CLUSTERS.test(normalized)) continue;

        let isBanned = false;
        for (const b of banned) {
            if (b && normalized.includes(b.toLowerCase())) {
                isBanned = true;
                break;
            }
        }
        if (isBanned) continue;

        candidates.push({ domain: normalized, template, sources });
    }

    return candidates;
}

function applyTemplate(template, A, B, C, prefixes, suffixes) {
    const results = [];

    switch (template) {
        case 'A+B':
            for (const a of A) for (const b of B) {
                results.push({ domain: a + b, template: 'A+B', sources: `A:${a}, B:${b}` });
            }
            break;
        case 'B+A':
            for (const b of B) for (const a of A) {
                results.push({ domain: b + a, template: 'B+A', sources: `B:${b}, A:${a}` });
            }
            break;
        case 'A+B+C':
            for (const a of A) for (const b of B) for (const c of C) {
                results.push({ domain: a + b + c, template: 'A+B+C', sources: `A:${a}, B:${b}, C:${c}` });
            }
            break;
        case 'prefix+A+B':
            for (const p of prefixes) for (const a of A) for (const b of B) {
                results.push({ domain: p + a + b, template: 'prefix+A+B', sources: `pre:${p}, A:${a}, B:${b}` });
            }
            break;
        case 'A+B+suffix':
            for (const a of A) for (const b of B) for (const s of suffixes) {
                results.push({ domain: a + b + s, template: 'A+B+suffix', sources: `A:${a}, B:${b}, suf:${s}` });
            }
            break;
        case 'prefix+A+B+suffix':
            for (const p of prefixes) for (const a of A) for (const b of B) for (const s of suffixes) {
                results.push({ domain: p + a + b + s, template: 'prefix+A+B+suffix', sources: `pre:${p}, A:${a}, B:${b}, suf:${s}` });
            }
            break;
    }

    return results;
}

// Single-preset batch scoring (legacy)
async function scoreSingleBatch(batch, mode, apiKey) {
    const modeContext = MODE_CONTEXT[mode] || MODE_CONTEXT.brandable;
    const domainList = batch.map(c => `${c.domain} (template: ${c.template})`).join('\n');

    const prompt = `${SCORING_PROMPT}

TARGET NICHE:
${modeContext}

DOMAINS TO SCORE:
${domainList}`;

    try {
        const response = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'You are an expert domain appraiser. Return ONLY valid JSON array.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 4000
            })
        });

        if (!response.ok) {
            console.error('OpenAI error:', await response.text());
            return batch.map(c => ({ ...c, score: 0, bucket: 'PASS', reason: 'Scoring failed', use_case: '' }));
        }

        const data = await response.json();
        let content = data.choices?.[0]?.message?.content || '';

        if (content.startsWith('```')) {
            content = content.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
        }

        const scores = JSON.parse(content);
        const scoreMap = {};
        for (const s of scores) {
            scoreMap[s.domain.replace('.com', '').toLowerCase()] = s;
        }

        return batch.map(c => {
            const s = scoreMap[c.domain.toLowerCase()] || {};
            return {
                domain: c.domain,
                score: Math.min(10, Math.max(0, parseFloat(s.score) || 0)),
                bucket: ['FAST-FLIP', 'HOLD', 'PASS'].includes(s.bucket) ? s.bucket : 'PASS',
                reason: String(s.reason || '').slice(0, 200),
                use_case: String(s.use_case || '').slice(0, 50),
                templateUsed: c.template,
                sources: c.sources
            };
        });

    } catch (error) {
        console.error('Batch scoring error:', error);
        return batch.map(c => ({ ...c, score: 0, bucket: 'PASS', reason: 'Error', use_case: '' }));
    }
}

// Multi-preset batch scoring
async function scoreMultiPresetBatch(batch, presetIds, presetMap, apiKey) {
    // Build personas description
    const personas = presetIds.map((id, i) => {
        const p = presetMap[id] || { name: `Preset ${i + 1}`, description: 'General brandable domains' };
        const w = p.weights || {};
        const c = p.constraints || {};
        const banned = (p.bannedSubstrings || []).slice(0, 5).join(', ');

        return `${i + 1}) ID: "${id}" - ${p.name}
   Description: ${p.description || 'Brandable domains'}
   Max length: ${c.maxLen || 12}
   Weights: brandability=${w.brandability || 3.5}, pronunciation=${w.pronunciation || 2}, spelling=${w.spelling || 1.5}, meaning=${w.nativeMeaning || 1}, buyerIntent=${w.buyerIntent || 2}
   ${banned ? `Avoid: ${banned}` : ''}
   ${p.notes ? `Notes: ${p.notes}` : ''}`;
    }).join('\n\n');

    const domainList = batch.map(c => `${c.domain} (template: ${c.template})`).join('\n');

    const prompt = MULTI_PRESET_PROMPT
        .replace('{{PERSONAS}}', personas)
        .replace('{{DOMAINS}}', domainList);

    try {
        const response = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'You are an expert domain appraiser. Score against multiple personas. Return ONLY valid JSON array.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 8000
            })
        });

        if (!response.ok) {
            console.error('OpenAI error:', await response.text());
            return batch.map(c => createEmptyMultiResult(c, presetIds, presetMap));
        }

        const data = await response.json();
        let content = data.choices?.[0]?.message?.content || '';

        if (content.startsWith('```')) {
            content = content.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
        }

        const rawResults = JSON.parse(content);
        const resultMap = {};
        for (const r of rawResults) {
            const domain = String(r.domain || '').replace('.com', '').toLowerCase();
            resultMap[domain] = r;
        }

        return batch.map(c => {
            const r = resultMap[c.domain.toLowerCase()];
            if (!r || !r.resultsByPreset) {
                return createEmptyMultiResult(c, presetIds, presetMap);
            }
            return processMultiResult(c, r.resultsByPreset, presetIds, presetMap);
        });

    } catch (error) {
        console.error('Multi-preset batch error:', error);
        return batch.map(c => createEmptyMultiResult(c, presetIds, presetMap));
    }
}

function createEmptyMultiResult(candidate, presetIds, presetMap) {
    const scoreByPreset = {};
    for (const id of presetIds) scoreByPreset[id] = 0;
    return {
        domain: candidate.domain,
        templateUsed: candidate.template,
        sources: candidate.sources,
        bestPresetId: presetIds[0],
        bestPresetName: presetMap[presetIds[0]]?.name || presetIds[0],
        bestScore: 0,
        avgScore: 0,
        maxScore: 0,
        bucket: 'PASS',
        reason: 'Scoring failed',
        use_case: '',
        scoreByPreset
    };
}

function processMultiResult(candidate, resultsByPreset, presetIds, presetMap) {
    let bestScore = 0;
    let bestPresetId = presetIds[0];
    let bestBucket = 'PASS';
    let bestReason = '';
    let bestUseCase = '';
    const scoreByPreset = {};
    const scores = [];

    for (const pid of presetIds) {
        const result = resultsByPreset[pid] || {};
        const score = Math.min(10, Math.max(0, parseFloat(result.score) || 0));
        scoreByPreset[pid] = Math.round(score * 10) / 10;
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

    // Determine final bucket
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
        domain: candidate.domain,
        templateUsed: candidate.template,
        sources: candidate.sources,
        bestPresetId,
        bestPresetName: presetMap[bestPresetId]?.name || bestPresetId,
        bestScore: Math.round(bestScore * 10) / 10,
        avgScore: Math.round(avgScore * 10) / 10,
        maxScore: Math.round(bestScore * 10) / 10,
        bucket: finalBucket,
        reason: bestReason,
        use_case: bestUseCase,
        scoreByPreset
    };
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

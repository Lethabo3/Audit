const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = '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';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

let supabaseUrl = null;
let supabaseKey = null;
let cachedSchema = null;
let cachedFindings = [];

async function supabaseFetch(endpoint, options = {}) {
    const response = await fetch(`${supabaseUrl}${endpoint}`, {
        ...options,
        headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': options.prefer || 'return=representation',
            ...options.headers
        }
    });
    return response;
}

// Connect using Supabase URL and anon key
app.post('/api/connect', async (req, res) => {
    const { projectUrl, anonKey } = req.body;
    
    try {
        // Normalize URL
        let url = projectUrl.trim();
        if (!url.startsWith('http')) {
            url = `https://${url}`;
        }
        if (!url.includes('.supabase.co')) {
            url = `https://${url}.supabase.co`;
        }
        url = url.replace(/\/$/, '');
        
        supabaseUrl = `${url}/rest/v1`;
        supabaseKey = anonKey.trim();
        
        // Test connection by fetching OpenAPI spec
        const testResponse = await fetch(`${url}/rest/v1/`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });
        
        if (!testResponse.ok) {
            throw new Error('Invalid credentials or project URL');
        }
        
        // Extract project name from URL
        const projectName = url.match(/https?:\/\/([^.]+)/)?.[1] || 'project';
        
        cachedSchema = null;
        cachedFindings = [];
        
        res.json({ success: true, projectName });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get schema from Supabase OpenAPI spec
app.get('/api/schema', async (req, res) => {
    if (!supabaseUrl || !supabaseKey) {
        return res.status(400).json({ error: 'No project connected' });
    }
    
    try {
        // Get OpenAPI spec which contains table definitions
        const specResponse = await fetch(supabaseUrl.replace('/rest/v1', '/rest/v1/'), {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });
        
        const spec = await specResponse.json();
        const tables = [];
        
        // Parse definitions from OpenAPI spec
        if (spec.definitions) {
            for (const [tableName, definition] of Object.entries(spec.definitions)) {
                // Skip internal tables
                if (tableName.startsWith('_') || tableName.includes('.')) continue;
                
                const columns = [];
                if (definition.properties) {
                    for (const [colName, colDef] of Object.entries(definition.properties)) {
                        columns.push({
                            column_name: colName,
                            data_type: colDef.format || colDef.type || 'unknown',
                            description: colDef.description || null
                        });
                    }
                }
                
                // Get row count
                let rowCount = 0;
                try {
                    const countResponse = await supabaseFetch(`/${tableName}?select=count`, {
                        headers: { 'Prefer': 'count=exact' }
                    });
                    const countHeader = countResponse.headers.get('content-range');
                    if (countHeader) {
                        const match = countHeader.match(/\/(\d+)/);
                        rowCount = match ? parseInt(match[1]) : 0;
                    }
                } catch (e) {
                    // Table might not be accessible
                }
                
                tables.push({
                    name: tableName,
                    columns,
                    rowCount,
                    status: 'clean'
                });
            }
        }
        
        cachedSchema = tables.filter(t => t.columns.length > 0);
        res.json({ tables: cachedSchema });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Run audit
app.post('/api/audit', async (req, res) => {
    if (!supabaseUrl || !supabaseKey || !cachedSchema) {
        return res.status(400).json({ error: 'No project connected or schema not loaded' });
    }
    
    try {
        const findings = [];
        
        for (const table of cachedSchema) {
            if (table.rowCount === 0) continue;
            
            // Fetch sample data to analyze
            const sampleResponse = await supabaseFetch(`/${table.name}?limit=1000`);
            if (!sampleResponse.ok) continue;
            
            const rows = await sampleResponse.json();
            if (!rows || rows.length === 0) continue;
            
            for (const column of table.columns) {
                const colName = column.column_name;
                const values = rows.map(r => r[colName]);
                
                // Check NULL rate
                const nullCount = values.filter(v => v === null || v === undefined).length;
                const nullRate = (nullCount / values.length) * 100;
                
                if (nullRate > 10) {
                    findings.push({
                        severity: nullRate > 30 ? 'critical' : 'warning',
                        table: table.name,
                        column: colName,
                        type: 'null_rate',
                        summary: `${nullRate.toFixed(1)}% NULL rate detected (${nullCount} of ${values.length} sampled rows).`,
                        stats: { nullCount, total: values.length, nullRate }
                    });
                }
                
                // Check duplicates for string columns
                const nonNullValues = values.filter(v => v !== null && v !== undefined);
                if (typeof nonNullValues[0] === 'string' && nonNullValues.length > 10) {
                    const counts = {};
                    nonNullValues.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
                    
                    const duplicates = Object.entries(counts)
                        .filter(([_, count]) => count > 1)
                        .sort((a, b) => b[1] - a[1]);
                    
                    const totalDuplicates = duplicates.reduce((sum, [_, c]) => sum + c - 1, 0);
                    
                    if (totalDuplicates > 5 && duplicates.length > 0) {
                        findings.push({
                            severity: totalDuplicates > 50 ? 'critical' : 'warning',
                            table: table.name,
                            column: colName,
                            type: 'duplicates',
                            summary: `${totalDuplicates} duplicate values across ${duplicates.length} distinct values.`,
                            samples: duplicates.slice(0, 5).map(([val, count]) => ({ value: val, count })),
                            stats: { totalDuplicates, distinctDuplicates: duplicates.length }
                        });
                    }
                }
                
                // Check numeric anomalies
                const numericValues = nonNullValues.filter(v => typeof v === 'number');
                if (numericValues.length > 10) {
                    // Negative values check
                    const negativeCount = numericValues.filter(v => v < 0).length;
                    if (negativeCount > 0 && (colName.includes('amount') || colName.includes('price') || 
                        colName.includes('quantity') || colName.includes('count') || colName.includes('total'))) {
                        findings.push({
                            severity: 'warning',
                            table: table.name,
                            column: colName,
                            type: 'negative_values',
                            summary: `${negativeCount} negative values in column that typically should be positive.`,
                            stats: { 
                                negativeCount, 
                                total: numericValues.length,
                                min: Math.min(...numericValues),
                                max: Math.max(...numericValues)
                            }
                        });
                    }
                    
                    // Outlier detection using IQR
                    const sorted = [...numericValues].sort((a, b) => a - b);
                    const q1 = sorted[Math.floor(sorted.length * 0.25)];
                    const q3 = sorted[Math.floor(sorted.length * 0.75)];
                    const iqr = q3 - q1;
                    const lowerBound = q1 - 1.5 * iqr;
                    const upperBound = q3 + 1.5 * iqr;
                    
                    const outliers = numericValues.filter(v => v < lowerBound || v > upperBound);
                    const outlierRate = (outliers.length / numericValues.length) * 100;
                    
                    if (outlierRate > 2 && outliers.length > 5) {
                        findings.push({
                            severity: outlierRate > 10 ? 'critical' : 'warning',
                            table: table.name,
                            column: colName,
                            type: 'outliers',
                            summary: `${outliers.length} statistical outliers detected (${outlierRate.toFixed(1)}% of data).`,
                            stats: { 
                                outlierCount: outliers.length, 
                                total: numericValues.length,
                                bounds: { lower: lowerBound, upper: upperBound }
                            }
                        });
                    }
                }
                
                // Check for empty strings
                if (typeof nonNullValues[0] === 'string') {
                    const emptyCount = nonNullValues.filter(v => v.trim() === '').length;
                    const emptyRate = (emptyCount / values.length) * 100;
                    
                    if (emptyRate > 5) {
                        findings.push({
                            severity: emptyRate > 20 ? 'critical' : 'warning',
                            table: table.name,
                            column: colName,
                            type: 'empty_strings',
                            summary: `${emptyRate.toFixed(1)}% empty strings detected (${emptyCount} rows).`,
                            stats: { emptyCount, total: values.length, emptyRate }
                        });
                    }
                }
            }
        }
        
        // Update table statuses
        for (const table of cachedSchema) {
            const tableFindings = findings.filter(f => f.table === table.name);
            const hasCritical = tableFindings.some(f => f.severity === 'critical');
            const hasWarning = tableFindings.some(f => f.severity === 'warning');
            table.status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'clean';
        }
        
        cachedFindings = findings;
        
        res.json({
            findings,
            tables: cachedSchema,
            summary: {
                totalFindings: findings.length,
                criticalCount: findings.filter(f => f.severity === 'critical').length,
                warningCount: findings.filter(f => f.severity === 'warning').length,
                tablesScanned: cachedSchema.length
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get detailed analysis for a finding
app.post('/api/analyze', async (req, res) => {
    if (!supabaseUrl || !supabaseKey) {
        return res.status(400).json({ error: 'No project connected' });
    }
    
    const { finding } = req.body;
    
    try {
        // Fetch sample data for this specific issue
        let sampleData = [];
        const sampleResponse = await supabaseFetch(`/${finding.table}?limit=100`);
        
        if (sampleResponse.ok) {
            const allRows = await sampleResponse.json();
            
            switch (finding.type) {
                case 'null_rate':
                    sampleData = allRows.filter(r => r[finding.column] === null).slice(0, 10);
                    break;
                case 'duplicates':
                    if (finding.samples && finding.samples[0]) {
                        const dupValue = finding.samples[0].value;
                        sampleData = allRows.filter(r => r[finding.column] === dupValue).slice(0, 10);
                    }
                    break;
                case 'negative_values':
                    sampleData = allRows.filter(r => r[finding.column] < 0).slice(0, 10);
                    break;
                case 'outliers':
                    const { lower, upper } = finding.stats.bounds;
                    sampleData = allRows.filter(r => {
                        const v = r[finding.column];
                        return v !== null && (v < lower || v > upper);
                    }).slice(0, 10);
                    break;
                case 'empty_strings':
                    sampleData = allRows.filter(r => r[finding.column]?.trim?.() === '').slice(0, 10);
                    break;
                default:
                    sampleData = allRows.slice(0, 10);
            }
        }
        
        // Get AI analysis
        const aiPrompt = `You are a database quality analyst. Analyze this finding and provide:
1. Root cause analysis (2-3 sentences)
2. Business impact (1-2 sentences)  
3. Recommended fix (1-2 sentences)

Finding: ${finding.summary}
Table: ${finding.table}
Column: ${finding.column}
Type: ${finding.type}
Stats: ${JSON.stringify(finding.stats)}
Sample: ${JSON.stringify(sampleData.slice(0, 3))}

Respond in JSON: {"analysis": "...", "impact": "...", "fix": "..."}`;

        const aiResponse = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: aiPrompt }],
                max_tokens: 512,
                temperature: 0.3
            })
        });
        
        const aiData = await aiResponse.json();
        let analysis = { analysis: '', impact: '', fix: '' };
        
        try {
            const content = aiData.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                analysis = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            analysis = { 
                analysis: aiData.choices[0]?.message?.content || 'Unable to generate analysis',
                impact: '',
                fix: ''
            };
        }
        
        res.json({ finding, sampleData, analysis });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Natural language query
app.post('/api/query', async (req, res) => {
    if (!supabaseUrl || !supabaseKey || !cachedSchema) {
        return res.status(400).json({ error: 'No project connected' });
    }
    
    const { query } = req.body;
    
    try {
        const schemaContext = cachedSchema.map(t => 
            `${t.name} (${t.rowCount} rows): ${t.columns.map(c => c.column_name).join(', ')}`
        ).join('\n');
        
        const aiPrompt = `You are a database analyst. Given the schema and audit findings, answer the user's question.

Schema:
${schemaContext}

Audit findings:
${JSON.stringify(cachedFindings.slice(0, 10))}

Question: ${query}

Provide a helpful, concise response.`;

        const aiResponse = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: aiPrompt }],
                max_tokens: 1024,
                temperature: 0.7
            })
        });
        
        const aiData = await aiResponse.json();
        const response = aiData.choices[0]?.message?.content || 'Unable to process query';
        
        res.json({ response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Audit server running on http://localhost:${PORT}`);
});

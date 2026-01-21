const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Serve index.html for root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Store active connections
const connections = new Map();

// Generate connection ID
function generateConnectionId() {
    return Math.random().toString(36).substring(2, 15);
}

// Parse connection URL
function parseConnectionUrl(url, dbType) {
    try {
        const parsed = new URL(url);
        return {
            host: parsed.hostname,
            port: parsed.port || (dbType === 'postgresql' ? 5432 : 3306),
            database: parsed.pathname.slice(1),
            user: parsed.username,
            password: parsed.password
        };
    } catch (error) {
        throw new Error('Invalid connection URL format');
    }
}

// Helper function to get schema
async function getConnectionSchema(connection) {
    if (connection.type === 'postgresql') {
        const result = await connection.pool.query(`
            SELECT 
                t.table_name,
                array_agg(
                    json_build_object(
                        'column', c.column_name,
                        'type', c.data_type,
                        'nullable', c.is_nullable
                    )
                ) as columns
            FROM information_schema.tables t
            JOIN information_schema.columns c 
                ON t.table_name = c.table_name 
                AND t.table_schema = c.table_schema
            WHERE t.table_schema = 'public'
                AND t.table_type = 'BASE TABLE'
            GROUP BY t.table_name
            ORDER BY t.table_name
        `);
        return result.rows;
    } else if (connection.type === 'mysql') {
        const [result] = await connection.pool.query(`
            SELECT 
                t.TABLE_NAME as table_name,
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'column', c.COLUMN_NAME,
                        'type', c.DATA_TYPE,
                        'nullable', c.IS_NULLABLE
                    )
                ) as columns
            FROM information_schema.TABLES t
            JOIN information_schema.COLUMNS c 
                ON t.TABLE_NAME = c.TABLE_NAME 
                AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
            WHERE t.TABLE_SCHEMA = DATABASE()
                AND t.TABLE_TYPE = 'BASE TABLE'
            GROUP BY t.TABLE_NAME
            ORDER BY t.TABLE_NAME
        `);
        return result;
    }
    return [];
}

// Connect to database
app.post('/api/connect', async (req, res) => {
    const { dbType, connectionUrl, host, port, database, user, password } = req.body;

    try {
        let config;

        if (connectionUrl) {
            config = parseConnectionUrl(connectionUrl, dbType);
        } else {
            config = { host, port, database, user, password };
        }

        let connection;
        let schema = [];

        if (dbType === 'postgresql') {
            const pool = new Pool({
                host: config.host,
                port: config.port,
                database: config.database,
                user: config.user,
                password: config.password,
                max: 5,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000,
                ssl: {
                    rejectUnauthorized: false
                },
                family: 4  // Force IPv4 to avoid IPv6 connection issues
            });

            const client = await pool.connect();
            client.release();

            const schemaResult = await pool.query(`
                SELECT 
                    t.table_name,
                    array_agg(
                        json_build_object(
                            'column', c.column_name,
                            'type', c.data_type,
                            'nullable', c.is_nullable
                        )
                    ) as columns
                FROM information_schema.tables t
                JOIN information_schema.columns c 
                    ON t.table_name = c.table_name 
                    AND t.table_schema = c.table_schema
                WHERE t.table_schema = 'public'
                    AND t.table_type = 'BASE TABLE'
                GROUP BY t.table_name
                ORDER BY t.table_name
            `);

            schema = schemaResult.rows;
            connection = { type: 'postgresql', pool };

        } else if (dbType === 'mysql') {
            const pool = mysql.createPool({
                host: config.host,
                port: config.port,
                database: config.database,
                user: config.user,
                password: config.password,
                waitForConnections: true,
                connectionLimit: 5,
                queueLimit: 0,
                ssl: {
                    rejectUnauthorized: false
                }
            });

            const testConn = await pool.getConnection();
            testConn.release();

            const [schemaResult] = await pool.query(`
                SELECT 
                    t.TABLE_NAME as table_name,
                    JSON_ARRAYAGG(
                        JSON_OBJECT(
                            'column', c.COLUMN_NAME,
                            'type', c.DATA_TYPE,
                            'nullable', c.IS_NULLABLE
                        )
                    ) as columns
                FROM information_schema.TABLES t
                JOIN information_schema.COLUMNS c 
                    ON t.TABLE_NAME = c.TABLE_NAME 
                    AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
                WHERE t.TABLE_SCHEMA = ?
                    AND t.TABLE_TYPE = 'BASE TABLE'
                GROUP BY t.TABLE_NAME
                ORDER BY t.TABLE_NAME
            `, [config.database]);

            schema = schemaResult;
            connection = { type: 'mysql', pool };
        } else {
            return res.status(400).json({ error: 'Unsupported database type' });
        }

        const connectionId = generateConnectionId();
        connections.set(connectionId, connection);

        res.json({
            success: true,
            connectionId,
            schema,
            message: `Connected to ${dbType} database successfully`
        });

    } catch (error) {
        console.error('Connection error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to connect to database'
        });
    }
});

// Get schema
app.get('/api/schema/:connectionId', async (req, res) => {
    const { connectionId } = req.params;
    const connection = connections.get(connectionId);

    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }

    try {
        const schema = await getConnectionSchema(connection);
        res.json({ success: true, schema });

    } catch (error) {
        console.error('Schema fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch schema' });
    }
});

// Execute SQL
app.post('/api/execute', async (req, res) => {
    const { connectionId, sql } = req.body;
    const connection = connections.get(connectionId);

    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }

    if (!sql || !sql.trim()) {
        return res.status(400).json({ error: 'No SQL provided' });
    }

    try {
        let result;

        if (connection.type === 'postgresql') {
            const pgResult = await connection.pool.query(sql);
            result = {
                rows: pgResult.rows,
                rowCount: pgResult.rowCount,
                fields: pgResult.fields?.map(f => f.name) || []
            };

        } else if (connection.type === 'mysql') {
            const [rows, fields] = await connection.pool.query(sql);
            result = {
                rows: Array.isArray(rows) ? rows : [],
                rowCount: Array.isArray(rows) ? rows.length : rows.affectedRows,
                fields: fields?.map(f => f.name) || []
            };
        }

        res.json({
            success: true,
            result
        });

    } catch (error) {
        console.error('Query execution error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Query execution failed'
        });
    }
});

// Generate SQL from natural language
app.post('/api/generate-sql', async (req, res) => {
    const { connectionId, userQuery, dbType } = req.body;
    const connection = connections.get(connectionId);

    if (!connection) {
        return res.status(404).json({ 
            success: false, 
            error: 'Connection not found' 
        });
    }

    try {
        const schemaResult = await getConnectionSchema(connection);
        
        let schemaContext = '';
        if (schemaResult.length > 0) {
            schemaContext = '\n\nDatabase schema:\n';
            schemaResult.forEach(table => {
                schemaContext += `\nTable: ${table.table_name}\n`;
                const columns = typeof table.columns === 'string' 
                    ? JSON.parse(table.columns) 
                    : table.columns;
                columns.forEach(c => {
                    const nullable = c.nullable === 'YES' ? 'nullable' : 'NOT NULL';
                    schemaContext += `  - ${c.column} (${c.type}, ${nullable})\n`;
                });
            });
        }

        const prompt = `You are a SQL expert. Convert the following natural language request into a SQL query for a ${dbType || connection.type} database.
${schemaContext}
User request: "${userQuery}"

CRITICAL RULES:
1. For INSERT queries, you MUST provide values for ALL NOT NULL columns
2. Look at existing data in the database first if needed to understand patterns (use SELECT queries)
3. Use realistic sample data when the user doesn't specify exact values
4. For DELETE queries, use appropriate WHERE clauses to target specific rows
5. Return ONLY the SQL query, no explanations, no markdown, no backticks

Respond with ONLY the raw SQL query.`;

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 1024
            })
        });

        const groqData = await groqResponse.json();

        if (groqData.error) {
            throw new Error(groqData.error.message || 'API error');
        }

        if (!groqData.choices || !groqData.choices[0]) {
            throw new Error('No response from API');
        }

        const sql = groqData.choices[0].message.content.trim();

        res.json({
            success: true,
            sql
        });

    } catch (error) {
        console.error('SQL generation error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to generate SQL'
        });
    }
});

// Generate conversational response
app.post('/api/generate-response', async (req, res) => {
    const { connectionId, userQuery, result } = req.body;
    const connection = connections.get(connectionId);

    if (!connection) {
        return res.status(404).json({ 
            success: false, 
            error: 'Connection not found' 
        });
    }

    try {
        const prompt = `You are a helpful data analyst. The user asked: "${userQuery}"

The SQL query returned ${result.rowCount} row(s).

Here is the data (showing up to 50 rows):
${JSON.stringify(result.rows, null, 2)}

IMPORTANT RULES:
1. For INSERT, UPDATE, or DELETE operations: Give a ONE SENTENCE confirmation only. Example: "Successfully added 1 user to the waitlist." or "Updated 3 records in the products table."
2. For SELECT queries: Provide a natural, conversational response with the actual data and any interesting insights.
3. Always be concise and direct.
4. Format your response in plain text paragraphs, not as a list or table.`;

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: 2048
            })
        });

        const groqData = await groqResponse.json();

        if (groqData.error) {
            throw new Error(groqData.error.message || 'API error');
        }

        if (!groqData.choices || !groqData.choices[0]) {
            throw new Error('No response from API');
        }

        const response = groqData.choices[0].message.content.trim();

        res.json({
            success: true,
            response
        });

    } catch (error) {
        console.error('Response generation error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to generate response'
        });
    }
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    const { connectionId } = req.body;
    const connection = connections.get(connectionId);

    if (connection) {
        try {
            await connection.pool.end();
            connections.delete(connectionId);
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    }

    res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', connections: connections.size });
});

app.listen(PORT, () => {
    console.log(`Gem server running on http://localhost:${PORT}`);
});

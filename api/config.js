// Vercel Serverless Function: /config
// Supabase 연결 정보를 클라이언트에 제공합니다.
export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_KEY || '';

    const missing = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL');
    if (!supabaseKey) missing.push('SUPABASE_KEY');

    if (missing.length > 0) {
        return res.status(500).json({ error: `Supabase 환경 변수가 설정되지 않았습니다. (누락: ${missing.join(', ')})` });
    }

    return res.status(200).json({
        SUPABASE_URL: supabaseUrl,
        SUPABASE_KEY: supabaseKey,
    });
}

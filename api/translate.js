// Vercel Serverless Function: /api/translate
// Gemini API를 호출하여 번역 및 단어 추출을 수행합니다.
// 기존 server.py의 /api/translate 엔드포인트를 Node.js로 포팅한 버전입니다.

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb', // 이미지 업로드를 위해 크기 제한 확장
        },
    },
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });
    }

    const geminiKey = process.env.GEMINI_API_KEY || '';
    if (!geminiKey) {
        return res.status(400).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
    }

    const { text, source_lang = 'auto', target_lang = 'ko', image } = req.body;

    if (!text && !image) {
        return res.status(400).json({ error: '번역할 텍스트 또는 이미지가 필요합니다.' });
    }

    // Language names mapping
    const langNames = {
        ko: 'Korean (한국어)',
        en: 'English (영어)',
        ja: 'Japanese (일본어)',
        zh: 'Chinese (중국어)',
        es: 'Spanish (스페인어)',
        fr: 'French (프랑스어)',
        de: 'German (독일어)',
        auto: 'Auto-detected language',
    };

    const sourceName = langNames[source_lang] || source_lang;
    const targetName = langNames[target_lang] || target_lang;

    // Determine vocabulary extraction language
    let vocabLangCode = source_lang;
    if (source_lang === 'ko') {
        vocabLangCode = target_lang;
    } else if (target_lang === 'ko') {
        vocabLangCode = source_lang;
    } else if (source_lang === 'auto') {
        vocabLangCode = 'detected source language';
    }

    const vocabName = langNames[vocabLangCode] || vocabLangCode;

    // Build Gemini prompt
    let prompt =
        `You are a professional translator and language learning assistant.\n` +
        `Translate the text from ${sourceName} to ${targetName}.\n`;

    if (image) {
        prompt += `Perform OCR to read the text in the provided image first, and then translate the extracted text.\n`;
    } else {
        prompt += `Original text to translate:\n"""\n${text}\n"""\n`;
    }

    // Build Gemini API request parts
    const parts = [{ text: prompt }];
    if (image) {
        parts.push({
            inlineData: {
                mimeType: image.mime_type,
                data: image.data,
            },
        });
    }

    const payload = {
        contents: [{ parts }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: {
                    translated_text: { type: 'STRING', description: 'The translated text result' },
                    original_text: {
                        type: 'STRING',
                        description: 'The OCR-ed text if image was provided, or the original source text',
                    },
                    detected_source_language: {
                        type: 'STRING',
                        description: "The detected language code if source was 'auto'",
                    }
                },
                required: ['translated_text', 'original_text'],
            },
        },
    };

    const startTime = Date.now();
    const VERCEL_TIMEOUT_LIMIT = 9500; // 9.5s max to allow Vercel response buffer

    try {
        const isHeavy = !!image || (text && text.length > 500);

        const modelsToTry = [
            'gemini-flash-latest',
            'gemini-2.5-flash-lite',
            'gemini-3.1-flash-lite',
            'gemini-2.0-flash-lite',
            'gemini-flash-lite-latest'
        ];

        let responseText = '';
        let lastError = null;

        for (let i = 0; i < modelsToTry.length; i++) {
            const modelName = modelsToTry[i];
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;

            const elapsed = Date.now() - startTime;
            const remainingTime = VERCEL_TIMEOUT_LIMIT - elapsed;

            if (remainingTime < 1500) {
                console.warn(`Skipping model ${modelName} because remaining time is only ${remainingTime}ms`);
                continue;
            }

            // Cap the first attempt to leave time for backup models if it hangs.
            // Subsequent attempts get the full remaining time.
            let timeoutVal = remainingTime;
            if (i === 0 && remainingTime > 6000) {
                timeoutVal = isHeavy ? 7500 : 5000;
            }

            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutVal);
            });

            try {
                console.log(`Trying Gemini model (${i + 1}/${modelsToTry.length}): ${modelName} (timeout=${timeoutVal}ms, remaining=${remainingTime}ms)...`);
                const geminiResponse = await Promise.race([
                    fetch(geminiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }),
                    timeoutPromise
                ]);
                clearTimeout(timeoutId);

                if (!geminiResponse.ok) {
                    const errText = await geminiResponse.text();
                    throw new Error(`HTTP ${geminiResponse.status}: ${errText}`);
                }

                const geminiData = await geminiResponse.json();
                const candidates = geminiData.candidates || [];
                if (!candidates.length) {
                    throw new Error('candidates가 없습니다.');
                }

                const responseParts = candidates[0]?.content?.parts || [];
                if (!responseParts.length) {
                    throw new Error('content parts가 없습니다.');
                }

                responseText = responseParts[0]?.text || '';
                console.log(`Successfully received response from model: ${modelName}`);
                break; // Success! Break the loop
            } catch (err) {
                clearTimeout(timeoutId);
                lastError = `Model ${modelName} failed: ${err.message || err}`;
                console.warn(lastError);
            }
        }

    if (!responseText) {
        console.error('All Gemini models failed:', lastError);
        return res.status(502).json({ error: `모든 번역 모델 호출에 실패했습니다. 마지막 오류: ${lastError}` });
    }

    let result;
    try {
        result = JSON.parse(responseText);
    } catch (err) {
        console.error('Failed to parse Gemini response text as JSON:', err, responseText);
        return res.status(502).json({ error: '번역 데이터 파싱 실패', details: err.message });
    }

        return res.status(200).json(result);
    } catch (err) {
        console.error('Translation handler error:', err);
        return res.status(500).json({ error: `서버 오류: ${err.message}` });
    }
}

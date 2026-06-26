// Vercel Serverless Function: /api/ocr
// 이미지에서 텍스트를 추출(OCR)하는 역할을 수행합니다.
// 3단계 파이프라인 중 1단계(OCR)의 백엔드를 담당합니다.

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

    const { image } = req.body;

    if (!image || !image.data) {
        return res.status(400).json({ error: '인식할 이미지가 필요합니다.' });
    }

    // Build Gemini OCR prompt
    const prompt = 
        `Perform OCR to extract all readable text from the provided image.\n` +
        `Do not translate the text, just transcribe it exactly as it appears in the image.\n` +
        `Provide the output in JSON format matching the schema.`;

    const parts = [
        { text: prompt },
        {
            inlineData: {
                mimeType: image.mime_type,
                data: image.data,
            },
        }
    ];

    const payload = {
        contents: [{ parts }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: {
                    extracted_text: { type: 'STRING', description: 'The exact transcribed text from the image' },
                    detected_language: {
                        type: 'STRING',
                        description: 'The detected language code (e.g. ko, en, ja, zh)',
                    }
                },
                required: ['extracted_text'],
            },
        },
    };

    const startTime = Date.now();
    const VERCEL_TIMEOUT_LIMIT = 9500; // 9.5s max to allow Vercel response buffer

    // 무료 사용량이 많고 안정적인 모델들 우선순위 정렬
    const modelsToTry = [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-flash-latest',
        'gemini-2.5-flash',
        'gemini-3.5-flash'
    ];

    let responseText = '';
    let lastError = null;

    try {
        for (let i = 0; i < modelsToTry.length; i++) {
            const modelName = modelsToTry[i];
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;

            const elapsed = Date.now() - startTime;
            const remainingTime = VERCEL_TIMEOUT_LIMIT - elapsed;

            if (remainingTime < 1500) {
                console.warn(`Skipping model ${modelName} because remaining time is only ${remainingTime}ms`);
                continue;
            }

            // Cap timeout
            let timeoutVal = remainingTime;
            if (i === 0 && remainingTime > 6000) {
                timeoutVal = 7000;
            }

            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutVal);
            });

            try {
                console.log(`[OCR] Trying Gemini model (${i + 1}/${modelsToTry.length}): ${modelName} (timeout=${timeoutVal}ms)...`);
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
                console.log(`[OCR] Successfully received response from model: ${modelName}`);
                break; // Success! Break the loop
            } catch (err) {
                clearTimeout(timeoutId);
                lastError = `Model ${modelName} failed: ${err.message || err}`;
                console.warn(lastError);
            }
        }

        // Fallback to OpenAI if all Gemini models failed and OPENAI_API_KEY is available
        const openAIKey = process.env.OPENAI_API_KEY || '';
        if (!responseText && openAIKey) {
            console.log("[OCR] Falling back to OpenAI (gpt-4o-mini)...");
            const elapsed = Date.now() - startTime;
            const remainingTime = VERCEL_TIMEOUT_LIMIT - elapsed;

            if (remainingTime > 1500) {
                let timeoutId;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('OpenAI timeout')), remainingTime - 500);
                });

                try {
                    const messages = [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${image.mime_type};base64,${image.data}`
                                    }
                                }
                            ]
                        }
                    ];

                    const fetchPromise = fetch("https://api.openai.com/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${openAIKey}`
                        },
                        body: JSON.stringify({
                            model: "gpt-4o-mini",
                            messages: messages,
                            response_format: {
                                type: "json_schema",
                                json_schema: {
                                    name: "ocr_response",
                                    strict: true,
                                    schema: {
                                        type: "object",
                                        properties: {
                                            extracted_text: { type: "string" },
                                            detected_language: { type: "string" }
                                        },
                                        required: ["extracted_text", "detected_language"],
                                        additionalProperties: false
                                    }
                                }
                            }
                        })
                    });

                    const openaiResponse = await Promise.race([fetchPromise, timeoutPromise]);
                    clearTimeout(timeoutId);

                    if (!openaiResponse.ok) {
                        const errText = await openaiResponse.text();
                        throw new Error(`HTTP ${openaiResponse.status}: ${errText}`);
                    }

                    const openaiData = await openaiResponse.json();
                    responseText = openaiData.choices?.[0]?.message?.content || '';
                    console.log("[OCR] Successfully received OCR response from OpenAI (gpt-4o-mini)");
                } catch (err) {
                    clearTimeout(timeoutId);
                    lastError = `OpenAI fallback failed: ${err.message || err}`;
                    console.warn(lastError);
                }
            }
        }

        if (!responseText) {
            console.error('[OCR] All models failed:', lastError);
            return res.status(502).json({ error: `모든 OCR 모델 호출에 실패했습니다. 마지막 오류: ${lastError}` });
        }

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (err) {
            console.error('[OCR] Failed to parse response text as JSON:', err, responseText);
            return res.status(502).json({ error: 'OCR 데이터 파싱 실패', details: err.message });
        }

        return res.status(200).json(result);
    } catch (err) {
        console.error('[OCR] Handler error:', err);
        return res.status(500).json({ error: `서버 오류: ${err.message}` });
    }
}

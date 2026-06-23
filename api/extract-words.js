// Vercel Serverless Function: /api/extract-words
// 원문 및 번역 결과를 바탕으로 단어를 추출합니다.
// 기존 api/translate.js에서 단어 추출 로직을 분리한 파일입니다.

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '2mb',
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

    const { original_text, translated_text, source_lang = 'auto', target_lang = 'ko' } = req.body;

    if (!original_text) {
        return res.status(400).json({ error: '추출할 원문 텍스트(original_text)가 필요합니다.' });
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

    // Determine vocabulary extraction language (extract from foreign language)
    let vocabLangCode = source_lang;
    if (source_lang === 'ko') {
        vocabLangCode = target_lang;
    } else if (target_lang === 'ko') {
        vocabLangCode = source_lang;
    } else if (source_lang === 'auto') {
        vocabLangCode = 'detected source language';
    }

    const vocabName = langNames[vocabLangCode] || vocabLangCode;

    // Build Gemini vocabulary extraction prompt
    const prompt =
        `You are a professional language learning assistant.\n` +
        `We have an original text and its translation:\n` +
        `Original Text (${vocabName}):\n"""\n${original_text}\n"""\n` +
        `Translated Text (Korean):\n"""\n${translated_text}\n"""\n\n` +
        `=== VOCABULARY EXTRACTION PHASE ===\n` +
        `Extract key vocabulary words/phrases from the original text (${vocabName}) using context from the translation.\n` +
        `\n### CRITICAL INSTRUCTIONS (MUST FOLLOW):\n` +
        `1. For EVERY extracted word, you MUST produce ALL 6 fields:\n` +
        `   - word (original language)\n` +
        `   - translation (Korean)\n` +
        `   - language (English name, e.g. 'Japanese', 'English')\n` +
        `   - kanji (Japanese kanji/hiragana mixture as it appears, or empty string "" for non-Japanese)\n` +
        `   - furigana (Japanese reading in pure hiragana, or empty string "" for non-Japanese)\n` +
        `   - base_form (Japanese dictionary form of verbs/adjectives, or empty string "" for non-Japanese)\n` +
        `\n2. NO EXCEPTIONS: Every field MUST be present in every word object.\n` +
        `\n3. For Japanese words:\n` +
        `   - If the word contains Kanji:\n` +
        `     - kanji: The kanji/hiragana mixture form of the word (e.g., 食べている)\n` +
        `     - furigana: Pure hiragana reading of the kanji (e.g., たべている)\n` +
        `   - If the word contains NO Kanji (pure hiragana or katakana, e.g. ゆっくり, パン, コーヒー):\n` +
        `     - kanji: "" (empty string)\n` +
        `     - furigana: "" (empty string)\n` +
        `   - base_form: Dictionary form of verbs/adjectives (if it is a verb or adjective conjugation e.g. 食べている -> 食べる; if it is not inflected or already dictionary form, set to "" empty string)\n` +
        `\n4. For non-Japanese:\n` +
        `   - kanji: "" (empty string)\n` +
        `   - furigana: "" (empty string)\n` +
        `   - base_form: "" (empty string)\n` +
        `\n### EXAMPLES (STRICT FORMAT):\n` +
        `Japanese verb conjugation:\n` +
        `  {"word": "食べている", "translation": "먹고 있습니다", "language": "Japanese", "kanji": "食べている", "furigana": "たべている", "base_form": "食べる"}\n` +
        `Japanese noun:\n` +
        `  {"word": "毎日", "translation": "매일", "language": "Japanese", "kanji": "毎日", "furigana": "まいにち", "base_form": ""}\n` +
        `Japanese hiragana word:\n` +
        `  {"word": "ゆっくり", "translation": "천천히", "language": "Japanese", "kanji": "", "furigana": "", "base_form": ""}\n` +
        `English:\n` +
        `  {"word": "book", "translation": "책", "language": "English", "kanji": "", "furigana": "", "base_form": ""}\n` +
        `\n### EXTRACTION RULES:\n` +
        `- Extract BOTH basic (everyday, common vocabulary) and advanced (academic, professional, etc.) words/phrases. Do not limit to only difficult or rare words.\n` +
        `- Include common verbs, nouns, adjectives, adverbs, and conjunctions that are helpful for language learners of all levels.\n` +
        `- Extract as many vocabulary words/phrases as possible (up to 25-30 words, minimum 15 words if the text is long enough. Even for short texts, include basic words to reach at least 10-15 words).\n` +
        `- **CRITICAL FOR JAPANESE**: You MUST extract a balanced mix of Kanji, Hiragana-only, and Katakana-only words. At least 35% of the extracted Japanese words must be pure Hiragana (e.g., adverbs like 'ゆっくり', 'ちょっと', 'ほとんど', conjunctions like 'しかし', 'だから', verbs written in hiragana) or Katakana loanwords (e.g., 'コーヒー', 'パン', 'ホテル', 'パソコン'). Do NOT extract only Kanji-containing words.\n` +
        `- For verbs, adjectives, and inflected words in non-dictionary form, ALWAYS provide their base_form.\n` +
        `- Skip basic grammatical particles (은/는/이/가 in Korean, or は/が/을/를/에/에서/도/니/へ/で in Japanese) unless they are part of a compound phrase.\n` +
        `\n### OUTPUT VALIDATION:\n` +
        `Before returning, verify:\n` +
        `- ✓ Every word object has exactly 6 fields\n` +
        `- ✓ No fields are missing or null (use "" for non-Japanese instead)\n` +
        `- ✓ Japanese words have kanji, furigana, base_form filled\n` +
        `- ✓ Non-Japanese words have empty strings for kanji/furigana/base_form\n`;

    const parts = [{ text: prompt }];

    const payload = {
        contents: [{ parts }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: {
                    words: {
                        type: 'ARRAY',
                        description: 'Extracted foreign words and their Korean translations. For Japanese, includes kanji, furigana, and base_form.',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                word: { type: 'STRING', description: 'The word in its original language' },
                                translation: { type: 'STRING', description: 'Korean translation' },
                                language: { type: 'STRING', description: "Language name in English (e.g., 'English', 'Japanese')" },
                                kanji: { type: 'STRING', description: 'Japanese kanji/hiragana form, or null for non-Japanese' },
                                furigana: { type: 'STRING', description: 'Japanese furigana (reading), or null for non-Japanese' },
                                base_form: { type: 'STRING', description: 'Base form (dictionary form) of Japanese verbs, or null for non-Japanese' },
                            },
                            required: ['word', 'translation', 'language', 'kanji', 'furigana', 'base_form'],
                        },
                    },
                },
                required: ['words'],
            },
        },
    };

    const modelsToTry = [
        'gemini-flash-latest',
        'gemini-2.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-2.0-flash-lite',
        'gemini-flash-lite-latest',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-3.5-flash'
    ];

    let responseText = '';
    let lastError = null;

    const startTime = Date.now();
    const VERCEL_TIMEOUT_LIMIT = 9500; // 9.5s max to allow Vercel response buffer

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

            // Cap the first attempt to leave time for backup models if it hangs.
            // Subsequent attempts get the full remaining time.
            let timeoutVal = remainingTime;
            if (i === 0 && remainingTime > 6000) {
                timeoutVal = 7000;
            }

            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutVal);
            });

            try {
                console.log(`Trying Gemini vocab model (${i + 1}/${modelsToTry.length}): ${modelName} (timeout=${timeoutVal}ms, remaining=${remainingTime}ms)...`);
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
                console.log(`Successfully received vocab response from model: ${modelName}`);
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
            console.log("Falling back to OpenAI for vocabulary extraction...");
            const elapsed = Date.now() - startTime;
            const remainingTime = VERCEL_TIMEOUT_LIMIT - elapsed;

            if (remainingTime > 1500) {
                let timeoutId;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('OpenAI timeout')), remainingTime - 500);
                });

                try {
                    const fetchPromise = fetch("https://api.openai.com/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${openAIKey}`
                        },
                        body: JSON.stringify({
                            model: "gpt-4o-mini",
                            messages: [{ role: "user", content: prompt }],
                            response_format: {
                                type: "json_schema",
                                json_schema: {
                                    name: "vocabulary_response",
                                    strict: true,
                                    schema: {
                                        type: "object",
                                        properties: {
                                            words: {
                                                type: "array",
                                                items: {
                                                    type: "object",
                                                    properties: {
                                                        word: { type: "string" },
                                                        translation: { type: "string" },
                                                        language: { type: "string" },
                                                        kanji: { type: "string" },
                                                        furigana: { type: "string" },
                                                        base_form: { type: "string" }
                                                    },
                                                    required: ["word", "translation", "language", "kanji", "furigana", "base_form"],
                                                    additionalProperties: false
                                                }
                                            }
                                        },
                                        required: ["words"],
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
                    console.log("Successfully received vocabulary response from OpenAI (gpt-4o-mini)");
                } catch (err) {
                    clearTimeout(timeoutId);
                    lastError = `OpenAI fallback failed: ${err.message || err}`;
                    console.warn(lastError);
                }
            }
        }

        if (!responseText) {
            console.error('All Gemini vocab models failed:', lastError);
            return res.status(502).json({ error: `모든 단어 추출 모델 호출에 실패했습니다. 마지막 오류: ${lastError}` });
        }

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (err) {
            console.error('Failed to parse Gemini vocab response text as JSON:', err, responseText);
            return res.status(502).json({ error: '단어 데이터 파싱 실패', details: err.message });
        }

        // Deterministic post-processing for Japanese words
        if (result.words && Array.isArray(result.words)) {
            result.words = result.words.map(w => {
                if (w.word) w.word = w.word.trim();
                if (w.translation) w.translation = w.translation.trim();
                if (w.kanji) w.kanji = w.kanji.trim();
                if (w.furigana) w.furigana = w.furigana.trim();
                if (w.base_form) w.base_form = w.base_form.trim();

                if (w.language === 'Japanese' || w.language === 'ja') {
                    // Check if word contains any Kanji characters
                    const hasKanji = /[\u4e00-\u9faf\u3400-\u4dbf]/.test(w.word || '');
                    if (!hasKanji) {
                        // Pure hiragana/katakana word: clear kanji and furigana fields
                        w.kanji = "";
                        w.furigana = "";
                    }
                    // Clear redundant base form if identical to the word or kanji
                    if (w.base_form === w.word || w.base_form === w.kanji) {
                        w.base_form = "";
                    }
                }
                return w;
            });
        }

        return res.status(200).json(result);
    } catch (err) {
        console.error('Vocabulary handler error:', err);
        return res.status(500).json({ error: `서버 오류: ${err.message}` });
    }
}

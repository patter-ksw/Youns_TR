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

    prompt +=
        `\n=== VOCABULARY EXTRACTION PHASE ===\n` +
        `Extract key vocabulary words/phrases from the ${vocabName} text.\n` +
        `\n### CRITICAL INSTRUCTIONS (MUST FOLLOW):\n` +
        `1. For EVERY extracted word, you MUST produce ALL 6 fields:\n` +
        `   - word (original language)\n` +
        `   - translation (Korean)\n` +
        `   - language (English name)\n` +
        `   - kanji (Japanese kanji/hiragana, or empty string "" for non-Japanese)\n` +
        `   - furigana (Japanese reading, or empty string "" for non-Japanese)\n` +
        `   - base_form (Japanese dictionary form, or empty string "" for non-Japanese)\n` +
        `\n2. NO EXCEPTIONS: Every field MUST be present in every word object.\n` +
        `\n3. For Japanese words:\n` +
        `   - If the word contains Kanji:\n` +
        `     - kanji: The kanji/hiragana mixture form of the word (e.g., 食べている)\n` +
        `     - furigana: Pure hiragana reading of the kanji (e.g., たべている)\n` +
        `   - If the word contains NO Kanji (pure hiragana or katakana, e.g. ゆっくり, パン):\n` +
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
        `- Extract as many vocabulary words/phrases as possible (up to 25-30 words, minimum 12 words if the text is long enough).\n` +
        `- For Japanese, you MUST extract words written in Hiragana (e.g. adverbs, conjunctions) and Katakana (e.g. loanwords) as well as Kanji words. Do not limit to only words containing Kanji.\n` +
        `- Include verbs, nouns, adjectives, adverbs, conjunctions, and katakana loanwords.\n` +
        `- For verbs, adjectives, and inflected words in non-dictionary form, ALWAYS provide their base_form.\n` +
        `- Skip basic grammatical particles (은/는/이/가 in Korean, or は/が/を/에/에/に in Japanese) unless they are part of a compound phrase.\n` +
        `\n### OUTPUT VALIDATION:\n` +
        `Before returning, verify:\n` +
        `- ✓ Every word object has exactly 6 fields\n` +
        `- ✓ No fields are missing or null (use "" for non-Japanese instead)\n` +
        `- ✓ Japanese words have kanji, furigana, base_form filled\n` +
        `- ✓ Non-Japanese words have empty strings for kanji/furigana/base_form\n`;

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
                    },
                    words: {
                        type: 'ARRAY',
                        description:
                            'Extracted foreign words and their Korean translations. For Japanese, includes kanji, furigana, and base_form.',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                word: { type: 'STRING', description: 'The word in its original language' },
                                translation: { type: 'STRING', description: 'Korean translation' },
                                language: {
                                    type: 'STRING',
                                    description: "Language name in English (e.g., 'English', 'Japanese')",
                                },
                                kanji: {
                                    type: 'STRING',
                                    description: 'Japanese kanji/hiragana form, or null for non-Japanese',
                                },
                                furigana: {
                                    type: 'STRING',
                                    description: 'Japanese furigana (reading), or null for non-Japanese',
                                },
                                base_form: {
                                    type: 'STRING',
                                    description:
                                        'Base form (dictionary form) of Japanese verbs, or null for non-Japanese',
                                },
                            },
                            required: ['word', 'translation', 'language', 'kanji', 'furigana', 'base_form'],
                        },
                    },
                },
                required: ['translated_text', 'original_text', 'words'],
            },
        },
    };

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

        // Determine timeout dynamically:
        // Heavy payloads (OCR or long text) get 9.0s on the first attempt so Gemini has enough time to finish.
        // Light payloads (short text) get sliced into 4.5s for 1st attempt, 4.5s for 2nd.
        let timeoutVal = 4500;
        if (isHeavy) {
            timeoutVal = (i === 0) ? 9000 : 500;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutVal);

        try {
            console.log(`Trying Gemini model (${i + 1}/${modelsToTry.length}): ${modelName} (timeout=${timeoutVal}ms)...`);
            const geminiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
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
        console.error('Translation handler error:', err);
        return res.status(500).json({ error: `서버 오류: ${err.message}` });
    }
}

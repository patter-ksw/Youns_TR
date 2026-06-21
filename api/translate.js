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
        `   - kanji: Write the word exactly as it appears (kanji + hiragana mix)\n` +
        `   - furigana: Pure hiragana reading (e.g., たべる)\n` +
        `   - base_form: Dictionary form of verbs (if verb is 食べている → 食べる; if already dictionary form → same as kanji)\n` +
        `\n4. For non-Japanese:\n` +
        `   - kanji: "" (empty string)\n` +
        `   - furigana: "" (empty string)\n` +
        `   - base_form: "" (empty string)\n` +
        `\n### EXAMPLES (STRICT FORMAT):\n` +
        `Japanese verb conjugation:\n` +
        `  {"word": "食べている", "translation": "먹고 있습니다", "language": "Japanese", "kanji": "食べている", "furigana": "たべている", "base_form": "食べる"}\n` +
        `Japanese noun:\n` +
        `  {"word": "毎日", "translation": "매일", "language": "Japanese", "kanji": "毎日", "furigana": "まいにち", "base_form": ""}\n` +
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

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;

    try {
        // Node 18+ on Vercel supports native fetch
        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            console.error('Gemini API Error:', errText);
            return res.status(502).json({ error: `Gemini API 오류 (${geminiResponse.status}): ${errText}` });
        }

        const geminiData = await geminiResponse.json();
        const candidates = geminiData.candidates || [];

        if (!candidates.length) {
            return res.status(502).json({ error: 'Gemini API 응답 오류: candidates가 없습니다.' });
        }

        const responseParts = candidates[0]?.content?.parts || [];
        if (!responseParts.length) {
            return res.status(502).json({ error: 'Gemini API 응답 오류: content parts가 없습니다.' });
        }

        const responseText = responseParts[0]?.text || '';

        // Parse and return Gemini's JSON response
        const result = JSON.parse(responseText);
        return res.status(200).json(result);
    } catch (err) {
        console.error('Translation handler error:', err);
        return res.status(500).json({ error: `서버 오류: ${err.message}` });
    }
}

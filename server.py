import http.server
import socketserver
import json
import os
import urllib.request
import urllib.error
from pathlib import Path

HERE = Path(__file__).parent

def load_env_file(env_path: Path):
    config = {}
    if not env_path.exists():
        return config
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        config[k.strip()] = v.strip()
    return config

class TranslationServerHandler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        # Enable CORS for local cross-origin testing if needed
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/config':
            env_config = load_env_file(HERE / '.env.local')
            url = env_config.get('SUPABASE_URL') or os.getenv('SUPABASE_URL', '')
            key = env_config.get('SUPABASE_KEY') or os.getenv('SUPABASE_KEY', '')
            
            response_data = {
                'SUPABASE_URL': url,
                'SUPABASE_KEY': key
            }
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response_data).encode('utf-8'))
        else:
            # Serve static files
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/translate':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            try:
                req_json = json.loads(post_data.decode('utf-8'))
                text = req_json.get('text', '')
                source_lang = req_json.get('source_lang', 'auto')
                target_lang = req_json.get('target_lang', 'ko')
                image_data = req_json.get('image') # {"mime_type": "...", "data": "base64..."}
                
                env_config = load_env_file(HERE / '.env.local')
                gemini_key = env_config.get('GEMINI_API_KEY') or os.getenv('GEMINI_API_KEY', '')
                
                if not gemini_key:
                    self.send_error_json(400, 'GEMINI_API_KEY가 설정되지 않았습니다. .env.local 파일을 확인하세요.')
                    return
                
                # Language names mapping for prompt clarity
                lang_names = {
                    'ko': 'Korean (한국어)',
                    'en': 'English (영어)',
                    'ja': 'Japanese (일본어)',
                    'zh': 'Chinese (중국어)',
                    'es': 'Spanish (스페인어)',
                    'fr': 'French (프랑스어)',
                    'de': 'German (독일어)',
                    'auto': 'Auto-detected language'
                }
                
                source_name = lang_names.get(source_lang, source_lang)
                target_name = lang_names.get(target_lang, target_lang)
                
                prompt = (
                    f"You are a professional translator and language learning assistant.\n"
                    f"Translate the text from {source_name} to {target_name}.\n"
                )
                
                if image_data:
                    prompt += "Perform OCR to read the text in the provided image first, and then translate the extracted text.\n"
                else:
                    prompt += f"Original text to translate:\n\"\"\"\n{text}\n\"\"\"\n"
                
                # Construct Gemini API Request payload
                parts = [{"text": prompt}]
                if image_data:
                    parts.append({
                        "inlineData": {
                            "mimeType": image_data.get("mime_type"),
                            "data": image_data.get("data")
                        }
                    })
                
                payload = {
                    "contents": [{
                        "parts": parts
                    }],
                    "generationConfig": {
                        "responseMimeType": "application/json",
                        "responseSchema": {
                            "type": "OBJECT",
                            "properties": {
                                "translated_text": {"type": "STRING", "description": "The translated text result"},
                                "original_text": {"type": "STRING", "description": "The OCR-ed text if image was provided, or the original source text"},
                                "detected_source_language": {"type": "STRING", "description": "The detected language code if source was 'auto'"}
                            },
                            "required": ["translated_text", "original_text"]
                        }
                    }
                }
                
                # Determine timeout dynamically based on request complexity
                is_heavy = bool(image_data) or (text and len(text) > 500)
                timeout_val = 15 if is_heavy else 8

                # Try multiple models sequentially in case of 429 quota limits or timeouts
                models_to_try = [
                    'gemini-flash-latest',
                    'gemini-2.5-flash-lite',
                    'gemini-3.1-flash-lite',
                    'gemini-2.0-flash-lite',
                    'gemini-flash-lite-latest',
                    'gemini-2.5-flash',
                    'gemini-2.0-flash',
                    'gemini-3.5-flash'
                ]
                
                response_text = ''
                last_error = None
                successful_model = None
                
                for idx, model_name in enumerate(models_to_try):
                    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/${model_name}:generateContent?key=${gemini_key}"
                    # Note: Since urllib/string interpolation in python uses normal string format, let's fix it:
                    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
                    
                    req = urllib.request.Request(
                        gemini_url,
                        data=json.dumps(payload).encode('utf-8'),
                        headers={'Content-Type': 'application/json'},
                        method='POST'
                    )
                    
                    try:
                        print(f"Trying Gemini translation model ({idx + 1}/{len(models_to_try)}): {model_name} (timeout={timeout_val}s)...")
                        with urllib.request.urlopen(req, timeout=timeout_val) as res:
                            res_body = res.read().decode('utf-8')
                            gemini_res = json.loads(res_body)
                            
                            # Extract JSON text output
                            candidates = gemini_res.get('candidates', [])
                            if not candidates:
                                raise ValueError(f"candidates가 없습니다. 응답: {res_body}")
                            
                            candidate = candidates[0]
                            parts = candidate.get('content', {}).get('parts', [])
                            if not parts:
                                raise ValueError("content parts가 없습니다.")
                            
                            response_text = parts[0].get('text', '')
                            successful_model = model_name
                            print(f"Successfully received translation response from model: {model_name}")
                            break # Success! Break the loop
                    except urllib.error.HTTPError as e:
                        try:
                            error_body = e.read().decode('utf-8')
                        except Exception:
                            error_body = "Could not read error body"
                        last_error = f"HTTP Error {e.code} for model {model_name}: {error_body}"
                        print(f"Warning: {last_error}")
                    except Exception as e:
                        last_error = f"Exception for model {model_name}: {str(e)}"
                        print(f"Warning: {last_error}")
                
                if not response_text:
                    print(f"All Gemini models failed. Last error: {last_error}")
                    self.send_error_json(502, f"모든 번역 모델 호출에 실패했습니다. 마지막 오류: {last_error}")
                    return

                # Return Gemini's JSON response directly to client
                try:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(response_text.encode('utf-8'))
                except ConnectionError:
                    pass
                    
            except Exception as e:
                self.send_error_json(400, f"요청 파싱 실패: {str(e)}")

        elif self.path == '/api/extract-words':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            try:
                req_json = json.loads(post_data.decode('utf-8'))
                original_text = req_json.get('original_text', '')
                translated_text = req_json.get('translated_text', '')
                source_lang = req_json.get('source_lang', 'auto')
                target_lang = req_json.get('target_lang', 'ko')
                
                env_config = load_env_file(HERE / '.env.local')
                gemini_key = env_config.get('GEMINI_API_KEY') or os.getenv('GEMINI_API_KEY', '')
                
                if not gemini_key:
                    self.send_error_json(400, 'GEMINI_API_KEY가 설정되지 않았습니다. .env.local 파일을 확인하세요.')
                    return
                
                if not original_text:
                    self.send_error_json(400, '추출할 원문 텍스트(original_text)가 필요합니다.')
                    return
                
                # Language names mapping
                lang_names = {
                    'ko': 'Korean (한국어)',
                    'en': 'English (영어)',
                    'ja': 'Japanese (일본어)',
                    'zh': 'Chinese (중국어)',
                    'es': 'Spanish (스페인어)',
                    'fr': 'French (프랑스어)',
                    'de': 'German (독일어)',
                    'auto': 'Auto-detected language'
                }
                
                vocab_lang_code = source_lang
                if source_lang == 'ko':
                    vocab_lang_code = target_lang
                elif target_lang == 'ko':
                    vocab_lang_code = source_lang
                elif source_lang == 'auto':
                    vocab_lang_code = 'detected source language'
                
                vocab_name = lang_names.get(vocab_lang_code, vocab_lang_code)
                
                prompt = (
                    f"You are a professional language learning assistant.\n"
                    f"We have an original text and its translation:\n"
                    f"Original Text ({vocab_name}):\n\"\"\"\n{original_text}\n\"\"\"\n"
                    f"Translated Text (Korean):\n\"\"\"\n{translated_text}\n\"\"\"\n\n"
                    f"=== VOCABULARY EXTRACTION PHASE ===\n"
                    f"Extract key vocabulary words/phrases from the original text ({vocab_name}) using context from the translation.\n"
                    f"\n### CRITICAL INSTRUCTIONS (MUST FOLLOW):\n"
                    f"1. For EVERY extracted word, you MUST produce ALL 6 fields:\n"
                    f"   - word (original language)\n"
                    f"   - translation (Korean)\n"
                    f"   - language (English name, e.g. 'Japanese', 'English')\n"
                    f"   - kanji (Japanese kanji/hiragana mixture as it appears, or empty string \"\" for non-Japanese)\n"
                    f"   - furigana (Japanese reading in pure hiragana, or empty string \"\" for non-Japanese)\n"
                    f"   - base_form (Japanese dictionary form of verbs/adjectives, or empty string \"\" for non-Japanese)\n"
                    f"\n2. NO EXCEPTIONS: Every field MUST be present in every word object.\n"
                    f"\n3. For Japanese words:\n"
                    f"   - If the word contains Kanji:\n"
                    f"     - kanji: The kanji/hiragana mixture form of the word (e.g., 食べている)\n"
                    f"     - furigana: Pure hiragana reading of the kanji (e.g., たべている)\n"
                    f"   - If the word contains NO Kanji (pure hiragana or katakana, e.g. ゆっくり, パン, 커피):\n"
                    f"     - kanji: \"\" (empty string)\n"
                    f"     - furigana: \"\" (empty string)\n"
                    f"   - base_form: Dictionary form of verbs/adjectives (if it is a verb or adjective conjugation e.g. 食べている -> 食べる; if it is not inflected or already dictionary form, set to \"\" empty string)\n"
                    f"\n4. For non-Japanese:\n"
                    f"   - kanji: \"\" (empty string)\n"
                    f"   - furigana: \"\" (empty string)\n"
                    f"   - base_form: \"\" (empty string)\n"
                    f"\n### EXAMPLES (STRICT FORMAT):\n"
                    f"Japanese verb conjugation:\n"
                    f'  {{"word": "食べている", "translation": "먹고 있습니다", "language": "Japanese", "kanji": "食べている", "furigana": "たべている", "base_form": "食べる"}}\n'
                    f"Japanese noun:\n"
                    f'  {{"word": "毎日", "translation": "매일", "language": "Japanese", "kanji": "毎日", "furigana": "まいにち", "base_form": ""}}\n'
                    f"Japanese hiragana word:\n"
                    f'  {{"word": "ゆっくり", "translation": "천천히", "language": "Japanese", "kanji": "", "furigana": "", "base_form": ""}}\n'
                    f"English:\n"
                    f'  {{"word": "book", "translation": "책", "language": "English", "kanji": "", "furigana": "", "base_form": ""}}\n'
                    f"\n### EXTRACTION RULES:\n"
                    f"- Extract BOTH basic (everyday, common vocabulary) and advanced (academic, professional, technical vocabulary) words/phrases. Do not limit to only difficult or rare words.\n"
                    f"- Include common verbs, nouns, adjectives, adverbs, and conjunctions that are helpful for language learners of all levels.\n"
                    f"- Extract as many vocabulary words/phrases as possible (up to 25-30 words, minimum 15 words if the text is long enough. Even for short texts, include basic words to reach at least 10-15 words).\n"
                    f"- For Japanese, you MUST extract words written in Hiragana (e.g. adverbs, conjunctions) and Katakana (e.g. loanwords) as well as Kanji words. Do not limit to only words containing Kanji.\n"
                    f"- Include verbs, nouns, adjectives, adverbs, conjunctions, and katakana loanwords.\n"
                    f"- For verbs, adjectives, and inflected words in non-dictionary form, ALWAYS provide their base_form.\n"
                    f"- Skip basic grammatical particles (은/는/이/가 in Korean, or は/가/을/에/に in Japanese) unless they are part of a compound phrase.\n"
                    f"\n### OUTPUT VALIDATION:\n"
                    f"Before returning, verify:\n"
                    f"- ✓ Every word object has exactly 6 fields\n"
                    f"- ✓ No fields are missing or null (use \"\" for non-Japanese instead)\n"
                    f"- ✓ Japanese words have kanji, furigana, base_form filled\n"
                    f"- ✓ Non-Japanese words have empty strings for kanji/furigana/base_form\n"
                )
                
                parts = [{"text": prompt}]
                payload = {
                    "contents": [{"parts": parts}],
                    "generationConfig": {
                        "responseMimeType": "application/json",
                        "responseSchema": {
                            "type": "OBJECT",
                            "properties": {
                                "words": {
                                    "type": "ARRAY",
                                    "description": "Extracted foreign words and their Korean translations. For Japanese, includes kanji, furigana, and base_form.",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "word": {"type": "STRING", "description": "The word in its original language"},
                                            "translation": {"type": "STRING", "description": "Korean translation"},
                                            "language": {"type": "STRING", "description": "Language name in English (e.g., 'English', 'Japanese')"},
                                            "kanji": {"type": "STRING", "description": "Japanese kanji/hiragana form, or null for non-Japanese"},
                                            "furigana": {"type": "STRING", "description": "Japanese furigana (reading), or null for non-Japanese"},
                                            "base_form": {"type": "STRING", "description": "Base form (dictionary form) of Japanese verbs, or null for non-Japanese"}
                                        },
                                        "required": ["word", "translation", "language", "kanji", "furigana", "base_form"]
                                    }
                                }
                            },
                            "required": ["words"]
                        }
                    }
                }
                
                timeout_val = 15
                models_to_try = [
                    'gemini-flash-latest',
                    'gemini-2.5-flash-lite',
                    'gemini-3.1-flash-lite',
                    'gemini-2.0-flash-lite',
                    'gemini-flash-lite-latest',
                    'gemini-2.5-flash',
                    'gemini-2.0-flash',
                    'gemini-3.5-flash'
                ]
                
                response_text = ''
                last_error = None
                successful_model = None
                
                for idx, model_name in enumerate(models_to_try):
                    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
                    
                    req = urllib.request.Request(
                        gemini_url,
                        data=json.dumps(payload).encode('utf-8'),
                        headers={'Content-Type': 'application/json'},
                        method='POST'
                    )
                    
                    try:
                        print(f"Trying Gemini vocab model ({idx + 1}/{len(models_to_try)}): {model_name} (timeout={timeout_val}s)...")
                        with urllib.request.urlopen(req, timeout=timeout_val) as res:
                            res_body = res.read().decode('utf-8')
                            gemini_res = json.loads(res_body)
                            
                            candidates = gemini_res.get('candidates', [])
                            if not candidates:
                                raise ValueError(f"candidates가 없습니다. 응답: {res_body}")
                            
                            candidate = candidates[0]
                            parts = candidate.get('content', {}).get('parts', [])
                            if not parts:
                                raise ValueError("content parts가 없습니다.")
                            
                            response_text = parts[0].get('text', '')
                            successful_model = model_name
                            print(f"Successfully received vocab response from model: {model_name}")
                            break
                    except urllib.error.HTTPError as e:
                        try:
                            error_body = e.read().decode('utf-8')
                        except Exception:
                            error_body = "Could not read error body"
                        last_error = f"HTTP Error {e.code} for model {model_name}: {error_body}"
                        print(f"Warning: {last_error}")
                    except Exception as e:
                        last_error = f"Exception for model {model_name}: {str(e)}"
                        print(f"Warning: {last_error}")
                
                if not response_text:
                    print(f"All Gemini vocab models failed. Last error: {last_error}")
                    self.send_error_json(502, f"모든 단어 추출 모델 호출에 실패했습니다. 마지막 오류: {last_error}")
                    return

                try:
                    result = json.loads(response_text)
                except Exception as parse_err:
                    print(f"Failed to parse Gemini vocab response text: {parse_err}")
                    self.send_error_json(502, f"단어 데이터 파싱 실패: {str(parse_err)}")
                    return
                
                if 'words' in result and isinstance(result['words'], list):
                    processed_words = []
                    for w in result['words']:
                        if 'word' in w and w['word']: w['word'] = w['word'].strip()
                        if 'translation' in w and w['translation']: w['translation'] = w['translation'].strip()
                        if 'kanji' in w and w['kanji']: w['kanji'] = w['kanji'].strip()
                        if 'furigana' in w and w['furigana']: w['furigana'] = w['furigana'].strip()
                        if 'base_form' in w and w['base_form']: w['base_form'] = w['base_form'].strip()
                        
                        if w.get('language') in ['Japanese', 'ja']:
                            import re
                            has_kanji = bool(re.search(r'[\u4e00-\u9faf\u3400-\u4dbf]', w.get('word', '')))
                            if not has_kanji:
                                w['kanji'] = ""
                                w['furigana'] = ""
                            if w.get('base_form') == w.get('word') or w.get('base_form') == w.get('kanji'):
                                w['base_form'] = ""
                        processed_words.append(w)
                    result['words'] = processed_words
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
                
            except Exception as e:
                self.send_error_json(400, f"요청 파싱 실패: {str(e)}")
        else:
            self.send_error(404, "Not Found")

    def send_error_json(self, status_code, message):
        try:
            self.send_response(status_code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': message}, ensure_ascii=False).encode('utf-8'))
        except ConnectionError:
            pass

if __name__ == '__main__':
    # Force current working directory to script directory
    os.chdir(str(HERE))
    
    # Load port from .env.local, default to 8001
    env_config = load_env_file(HERE / '.env.local')
    PORT = int(env_config.get('PORT', 8001))
    
    # Allow port reuse
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), TranslationServerHandler) as httpd:
        print(f"Youns TR 서버가 http://localhost:{PORT} 에서 실행 중입니다.")
        print("종료하려면 Ctrl+C를 누르세요.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n서버를 종료합니다.")

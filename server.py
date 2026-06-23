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
                
                # Determine which language to extract words from
                # Rule: extract words from the foreign language.
                # If either source or target is Korean, extract from the other.
                # If neither is Korean, extract from the source language.
                vocab_lang_code = source_lang
                if source_lang == 'ko':
                    vocab_lang_code = target_lang
                elif target_lang == 'ko':
                    vocab_lang_code = source_lang
                elif source_lang == 'auto' and target_lang != 'ko':
                    # If auto-detect and target is not Korean, we extract from the auto-detected source language.
                    vocab_lang_code = 'detected source language'
                elif source_lang == 'auto' and target_lang == 'ko':
                    # If auto-detect and target is Korean, we extract from the auto-detected source language.
                    vocab_lang_code = 'detected source language'
                
                vocab_name = lang_names.get(vocab_lang_code, vocab_lang_code)
                
                prompt = (
                    f"You are a professional translator and language learning assistant.\n"
                    f"Translate the text from {source_name} to {target_name}.\n"
                )
                
                if image_data:
                    prompt += "Perform OCR to read the text in the provided image first, and then translate the extracted text.\n"
                else:
                    prompt += f"Original text to translate:\n\"\"\"\n{text}\n\"\"\"\n"
                
                prompt += (
                    f"\n=== VOCABULARY EXTRACTION PHASE ===\n"
                    f"Extract key vocabulary words/phrases from the {vocab_name} text.\n"
                    f"\n### CRITICAL INSTRUCTIONS (MUST FOLLOW):\n"
                    f"1. For EVERY extracted word, you MUST produce ALL 6 fields:\n"
                    f"   - word (original language)\n"
                    f"   - translation (Korean)\n"
                    f"   - language (English name)\n"
                    f"   - kanji (Japanese kanji/hiragana, or empty string \"\" for non-Japanese)\n"
                    f"   - furigana (Japanese reading, or empty string \"\" for non-Japanese)\n"
                    f"   - base_form (Japanese dictionary form, or empty string \"\" for non-Japanese)\n"
                    f"\n2. NO EXCEPTIONS: Every field MUST be present in every word object.\n"
                    f"\n3. For Japanese words:\n"
                    f"   - kanji: Write the word exactly as it appears (kanji + hiragana mix)\n"
                    f"   - furigana: Pure hiragana reading (e.g., たべる)\n"
                    f"   - base_form: Dictionary form of verbs (if verb is 食べている → 食べる; if already dictionary form → same as kanji)\n"
                    f"\n4. For non-Japanese:\n"
                    f"   - kanji: \"\" (empty string)\n"
                    f"   - furigana: \"\" (empty string)\n"
                    f"   - base_form: \"\" (empty string)\n"
                    f"\n### EXAMPLES (STRICT FORMAT):\n"
                    f"Japanese verb conjugation:\n"
                    f'  {{"word": "食べている", "translation": "먹고 있습니다", "language": "Japanese", "kanji": "食べている", "furigana": "たべている", "base_form": "食べる"}}\n'
                    f"Japanese noun:\n"
                    f'  {{"word": "毎日", "translation": "매일", "language": "Japanese", "kanji": "毎日", "furigana": "まいにち", "base_form": ""}}\n'
                    f"English:\n"
                    f'  {{"word": "book", "translation": "책", "language": "English", "kanji": "", "furigana": "", "base_form": ""}}\n'
                    f"\n### EXTRACTION RULES:\n"
                    f"- Extract 8-15 important vocabulary words\n"
                    f"- Skip particles (は, を, に) unless contextually important\n"
                    f"- Include verbs (show conjugations + base form)\n"
                    f"- Include nouns and adjectives\n"
                    f"- For verbs in non-dictionary form, ALWAYS provide base_form\n"
                    f"\n### OUTPUT VALIDATION:\n"
                    f"Before returning, verify:\n"
                    f"- ✓ Every word object has exactly 6 fields\n"
                    f"- ✓ No fields are missing or null (use \"\" for non-Japanese instead)\n"
                    f"- ✓ Japanese words have kanji, furigana, base_form filled\n"
                    f"- ✓ Non-Japanese words have empty strings for kanji/furigana/base_form\n"
                )
                
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
                                "detected_source_language": {"type": "STRING", "description": "The detected language code if source was 'auto'"},
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
                            "required": ["translated_text", "original_text", "words"]
                        }
                    }
                }
                
                # Try multiple models sequentially in case of 429 quota limits or timeouts
                models_to_try = [
                    'gemini-flash-latest',
                    'gemini-2.5-flash-lite',
                    'gemini-3.1-flash-lite',
                    'gemini-2.0-flash-lite',
                    'gemini-flash-lite-latest'
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
                        print(f"Trying Gemini model ({idx + 1}/{len(models_to_try)}): {model_name}...")
                        # 12-second timeout per attempt to avoid hanging
                        with urllib.request.urlopen(req, timeout=12) as res:
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
                            print(f"Successfully received response from model: {model_name}")
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

                # Debug: Write Gemini's response to file
                with open('gemini_debug.log', 'a', encoding='utf-8') as f:
                    f.write(f"\n=== Gemini Response ({successful_model}) ===\n{response_text}\n{'='*50}\n")
                
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

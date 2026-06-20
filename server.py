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
                    f"\nAfter translation, extract key vocabulary words or short phrases from the {vocab_name} text (non-Korean language).\n"
                    f"Rules for word extraction:\n"
                    f"- Extract key words/phrases that are useful for language learning.\n"
                    f"- For each word, provide:\n"
                    f"  * 'word': the spelling in the original foreign language (e.g., 'book', '本', 'café')\n"
                    f"  * 'translation': Korean translation (field: 'translation')\n"
                    f"  * 'language': the language name in English (field: 'language', e.g., 'English', 'Japanese', 'Chinese', etc.)\n"
                    f"  * For Japanese ONLY:\n"
                    f"    - 'kanji': the kanji/hiragana form (e.g., 食べる)\n"
                    f"    - 'furigana': the hiragana reading with ruby text format (e.g., たべる)\n"
                    f"    - 'base_form': the base form (dictionary form) of the word if it's a verb conjugation. For example, if the word is 食べている, the base_form is 食べる. If it's already in base form, set base_form to the same as kanji.\n"
                    f"  * For non-Japanese languages, set kanji, furigana, and base_form to null.\n"
                    f"- If the vocabulary language is Korean (because both are Korean or similar), extract words in the other language instead.\n"
                    f"- Skip common grammar particles, basic prepositions, or pronouns unless they are important vocabulary.\n"
                    f"- Extract a maximum of 15 words.\n"
                    f"- Return the output as a valid JSON object matching the requested schema.\n"
                )
                
                # Construct Gemini API Request
                gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={gemini_key}"
                
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
                                        "required": ["word", "translation", "language"]
                                    }
                                }
                            },
                            "required": ["translated_text", "original_text", "words"]
                        }
                    }
                }
                
                # Make HTTP call to Gemini API
                req = urllib.request.Request(
                    gemini_url,
                    data=json.dumps(payload).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                
                try:
                    with urllib.request.urlopen(req) as res:
                        res_body = res.read().decode('utf-8')
                        gemini_res = json.loads(res_body)
                        
                        # Extract the JSON text output from Gemini
                        candidates = gemini_res.get('candidates', [])
                        if not candidates:
                            self.send_error_json(502, f"Gemini API 응답 오류: candidates가 없습니다. {res_body}")
                            return
                        
                        candidate = candidates[0]
                        parts = candidate.get('content', {}).get('parts', [])
                        if not parts:
                            self.send_error_json(502, "Gemini API 응답 오류: content parts가 없습니다.")
                            return
                        
                        response_text = parts[0].get('text', '')
                        
                        # Return Gemini's JSON response directly to client
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json; charset=utf-8')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.end_headers()
                        self.wfile.write(response_text.encode('utf-8'))
                        
                except urllib.error.HTTPError as e:
                    error_msg = e.read().decode('utf-8')
                    print(f"Gemini API HTTPError: {error_msg}")
                    self.send_error_json(502, f"Gemini API 오류 ({e.code}): {error_msg}")
                except Exception as e:
                    print(f"Gemini API Call Exception: {str(e)}")
                    self.send_error_json(500, f"Gemini API 호출 중 서버 오류 발생: {str(e)}")
                    
            except Exception as e:
                self.send_error_json(400, f"요청 파싱 실패: {str(e)}")
        else:
            self.send_error(404, "Not Found")

    def send_error_json(self, status_code, message):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}, ensure_ascii=False).encode('utf-8'))

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

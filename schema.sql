-- 1. Create tr_users table (사용자 테이블)
CREATE TABLE IF NOT EXISTS tr_users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Insert admin user if not exists (관리자 계정 삽입)
-- Username: admin_tr, Password: patter_tr, Role: admin
INSERT INTO tr_users (username, name, password, role)
SELECT 'admin_tr', '관리자', 'patter_tr', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM tr_users WHERE username = 'admin_tr');

-- 3. Create tr_global_words table (전체 단어장)
-- 일본어 필드 추가: kanji (한자), furigana (요미가나), base_form (동사 원형)
CREATE TABLE IF NOT EXISTS tr_global_words (
    id BIGSERIAL PRIMARY KEY,
    language TEXT NOT NULL,
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    kanji TEXT,              -- 일본어 한자 (예: 食べる)
    furigana TEXT,           -- 일본어 요미가나 (예: たべる)
    base_form TEXT,          -- 동사 원형 (예: 食べる)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT tr_global_words_unique UNIQUE (language, word)
);

-- 4. Create tr_user_words table (나만의 단어장)
-- 일본어 필드 추가: kanji (한자), furigana (요미가나), base_form (동사 원형)
CREATE TABLE IF NOT EXISTS tr_user_words (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES tr_users(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    kanji TEXT,              -- 일본어 한자 (예: 食べる)
    furigana TEXT,           -- 일본어 요미가나 (예: たべる)
    base_form TEXT,          -- 동사 원형 (예: 食べる)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT tr_user_words_unique UNIQUE (user_id, language, word)
);

-- 5. Disable Row Level Security (RLS 비활성화 - Youns PG와 동일한 방식)
ALTER TABLE tr_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE tr_global_words DISABLE ROW LEVEL SECURITY;
ALTER TABLE tr_user_words DISABLE ROW LEVEL SECURITY;

-- 6. Youns PG 연동 업데이트
-- Youns PG 대시보드 내 '번역기(단어장 만들기)' 서비스의 연결 URL을 Youns TR 포트인 8001로 업데이트
UPDATE services 
SET url = 'http://localhost:8001' 
WHERE title = '번역기(단어장 만들기)';

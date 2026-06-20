// Global App State
let supabaseClient = null;
let currentUser = null;
let currentFile = null; // { name, size, mime_type, base64Data }
let extractedWords = []; // List of words extracted from current translation

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
    await initSupabase();
    checkActiveSession();
    setupEventListeners();
});

// 1. Initialize Supabase
async function initSupabase() {
    try {
        const response = await fetch('/config');
        if (!response.ok) {
            throw new Error('서버로부터 설정을 가져오지 못했습니다.');
        }
        const config = await response.json();
        
        if (!config.SUPABASE_URL || !config.SUPABASE_KEY) {
            showToast('⚠️ Supabase 설정이 비어있습니다. .env.local을 확인해 주세요.', 'danger');
            return;
        }

        const { createClient } = window.supabase;
        supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);
    } catch (error) {
        console.error('Supabase 초기화 오류:', error);
        showToast('🚨 Supabase 서버 연결에 실패했습니다.', 'danger');
    }
}

// 2. Auth Session Management
function checkActiveSession() {
    const savedUser = localStorage.getItem('youns_tr_user');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            renderUserInterface();
        } catch (e) {
            localStorage.removeItem('youns_tr_user');
        }
    }
}

function renderUserInterface() {
    const authPanel = document.getElementById('auth-panel');
    const loginBtn = document.getElementById('btn-login-modal');
    const userInfoContainer = document.getElementById('user-info-container');
    const userDisplayName = document.getElementById('user-display-name');
    const adminBtn = document.getElementById('btn-global-wordbook');

    if (currentUser) {
        loginBtn.style.display = 'none';
        userInfoContainer.style.display = 'flex';
        userDisplayName.innerText = `👤 ${currentUser.name} 님`;
        
        // Show Admin button if user is admin_tr
        if (currentUser.role === 'admin' || currentUser.username === 'admin_tr') {
            adminBtn.style.display = 'flex';
        } else {
            adminBtn.style.display = 'none';
        }
    } else {
        loginBtn.style.display = 'flex';
        userInfoContainer.style.display = 'none';
        adminBtn.style.display = 'none';
    }
}

// 3. Event Listeners Setup
function setupEventListeners() {
    // Auth Modals Tabs
    const tabLogin = document.getElementById('tab-login');
    const tabSignup = document.getElementById('tab-signup');
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');

    tabLogin.addEventListener('click', () => {
        tabLogin.classList.add('active');
        tabSignup.classList.remove('active');
        loginForm.style.display = 'flex';
        signupForm.style.display = 'none';
    });

    tabSignup.addEventListener('click', () => {
        tabSignup.classList.add('active');
        tabLogin.classList.remove('active');
        signupForm.style.display = 'flex';
        loginForm.style.display = 'none';
    });

    // Show Login Modal
    document.getElementById('btn-login-modal').addEventListener('click', () => {
        openModal('login-modal');
    });

    // Auth Forms Submission
    loginForm.addEventListener('submit', handleLogin);
    signupForm.addEventListener('submit', handleSignup);

    // Logout
    document.getElementById('btn-logout').addEventListener('click', handleLogout);

    // Text Area Change Counter
    const sourceText = document.getElementById('source-text');
    const charCount = document.getElementById('current-char-count');
    sourceText.addEventListener('input', () => {
        charCount.innerText = sourceText.value.length;
    });

    // Swap Languages
    document.getElementById('btn-swap-langs').addEventListener('click', () => {
        const sourceLangSelect = document.getElementById('source-lang');
        const targetLangSelect = document.getElementById('target-lang');
        
        const sourceVal = sourceLangSelect.value;
        const targetVal = targetLangSelect.value;
        
        // Cannot set target lang to 'auto'
        if (sourceVal === 'auto') {
            sourceLangSelect.value = targetVal;
            targetLangSelect.value = 'ko'; // default target
        } else {
            sourceLangSelect.value = targetVal;
            targetLangSelect.value = sourceVal;
        }
    });

    // File Drag & Drop
    const dropZone = document.getElementById('drop-zone');
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleAttachedFile(files[0]);
        }
    });

    // File Upload via Button
    const fileUpload = document.getElementById('file-upload');
    fileUpload.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleAttachedFile(e.target.files[0]);
        }
    });

    // Remove Attached File
    document.getElementById('btn-remove-file').addEventListener('click', (e) => {
        e.stopPropagation();
        clearFileAttachment();
    });

    // Translate Button Action
    document.getElementById('btn-translate').addEventListener('click', executeTranslation);

    // Word Checkbox Selection Enabling "Add" Button
    document.getElementById('extracted-words-grid').addEventListener('change', (e) => {
        if (e.target.classList.contains('word-checkbox')) {
            updateAddWordsButtonState();
        }
    });

    // Add selected words to user's wordbook
    document.getElementById('btn-add-to-my-words').addEventListener('click', addSelectedWordsToMyWordbook);

    // My Wordbook Button
    document.getElementById('btn-my-wordbook').addEventListener('click', () => {
        openModal('my-wordbook-modal');
        loadMyWordbook();
    });

    // Global Wordbook Button
    document.getElementById('btn-global-wordbook').addEventListener('click', () => {
        openModal('global-wordbook-modal');
        loadGlobalWordbook();
    });

    // Search & Filter Wordbooks
    document.getElementById('my-wordbook-search').addEventListener('input', filterMyWordbook);
    document.getElementById('my-wordbook-lang').addEventListener('change', loadMyWordbook);
    document.getElementById('global-wordbook-search').addEventListener('input', filterGlobalWordbook);
    document.getElementById('global-wordbook-lang').addEventListener('change', loadGlobalWordbook);

    // Download Wordbook as Excel
    document.getElementById('btn-download-my-excel').addEventListener('click', () => {
        downloadWordbookAsExcel(localMyWords, `나만의 단어장_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
    
    document.getElementById('btn-download-global-excel').addEventListener('click', () => {
        downloadWordbookAsExcel(localGlobalWords, `전체 단어장_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });

    // Copy Translation Result
    const copyBtn = document.getElementById('btn-copy');
    copyBtn.addEventListener('click', () => {
        const targetText = document.getElementById('target-text').value;
        navigator.clipboard.writeText(targetText).then(() => {
            showToast('📋 번역 결과가 클립보드에 복사되었습니다.');
        }).catch(err => {
            showToast('복사에 실패했습니다.', 'danger');
        });
    });

    // TTS Audio Player
    const ttsBtn = document.getElementById('btn-tts');
    ttsBtn.addEventListener('click', () => {
        const targetText = document.getElementById('target-text').value;
        const targetLang = document.getElementById('target-lang').value;
        
        // Map language code to SpeechSynthesis locale
        const langLocaleMap = {
            'ko': 'ko-KR',
            'en': 'en-US',
            'ja': 'ja-JP',
            'zh': 'zh-CN',
            'es': 'es-ES',
            'fr': 'fr-FR',
            'de': 'de-DE'
        };
        
        if (window.speechSynthesis) {
            // Cancel current speaking if any
            window.speechSynthesis.cancel();
            
            const utterance = new SpeechSynthesisUtterance(targetText);
            utterance.lang = langLocaleMap[targetLang] || 'ko-KR';
            
            // Highlight TTS button state during voice playback
            ttsBtn.classList.add('btn-primary');
            utterance.onend = () => {
                ttsBtn.classList.remove('btn-primary');
            };
            utterance.onerror = () => {
                ttsBtn.classList.remove('btn-primary');
            };
            
            window.speechSynthesis.speak(utterance);
        } else {
            showToast('이 브라우저는 음성 합성(TTS)을 지원하지 않습니다.', 'danger');
        }
    });

    // Modal forms submission
    document.getElementById('edit-word-form').addEventListener('submit', handleWordEditSubmit);
}

// 4. File Attachment Handler
function handleAttachedFile(file) {
    const validTypes = ['text/plain', 'image/png', 'image/jpeg', 'image/webp'];
    if (!validTypes.includes(file.type) && !file.name.endsWith('.txt')) {
        showToast('⚠️ 지원하지 않는 파일 형식입니다. (.txt 또는 이미지 파일만 첨부 가능)', 'danger');
        return;
    }

    currentFile = {
        name: file.name,
        size: formatBytes(file.size),
        type: file.type
    };

    const reader = new FileReader();

    if (file.type.startsWith('image/')) {
        // Prepare image base64 data for Gemini Multimodal input
        reader.onload = function(e) {
            const base64Data = e.target.result;
            // Extract the pure base64 content
            currentFile.base64Data = base64Data.split(',')[1];
            currentFile.mime_type = file.type;
            
            // Hide image preview (미리보기 제거)
            document.getElementById('file-icon').innerText = '🖼️';
            showFileIndicator();
        };
        reader.readAsDataURL(file);
    } else {
        // Read text file directly to editor
        reader.onload = function(e) {
            const textContent = e.target.result;
            document.getElementById('source-text').value = textContent;
            document.getElementById('current-char-count').innerText = textContent.length;
            
            document.getElementById('image-preview-container').style.display = 'none';
            document.getElementById('file-icon').innerText = '📄';
            showFileIndicator();
        };
        reader.readAsText(file, 'utf-8');
    }
}

function showFileIndicator() {
    document.getElementById('file-name').innerText = currentFile.name;
    document.getElementById('file-size').innerText = currentFile.size;
    document.getElementById('file-indicator').style.display = 'flex';
}

function clearFileAttachment() {
    currentFile = null;
    document.getElementById('file-indicator').style.display = 'none';
    document.getElementById('file-upload').value = '';
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 5. Auth Handlers
async function handleLogin(e) {
    e.preventDefault();
    if (!supabaseClient) return;

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();

    showLoading(true, '로그인 진행 중...');

    try {
        const { data, error } = await supabaseClient
            .from('tr_users')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .maybeSingle();

        if (error) throw error;

        if (data) {
            currentUser = {
                id: data.id,
                username: data.username,
                name: data.name,
                role: data.role
            };
            localStorage.setItem('youns_tr_user', JSON.stringify(currentUser));
            renderUserInterface();
            closeModal('login-modal');
            showToast(`👋 ${currentUser.name}님, 환영합니다!`);
            document.getElementById('login-form').reset();
        } else {
            showToast('❌ 아이디 또는 비밀번호가 올바르지 않습니다.', 'danger');
        }
    } catch (err) {
        console.error('로그인 에러:', err);
        showToast('로그인 처리 중 오류 발생', 'danger');
    } finally {
        showLoading(false);
    }
}

async function handleSignup(e) {
    e.preventDefault();
    if (!supabaseClient) return;

    const username = document.getElementById('signup-username').value.trim();
    const name = document.getElementById('signup-name').value.trim();
    const password = document.getElementById('signup-password').value.trim();

    showLoading(true, '회원가입 처리 중...');

    try {
        // Check username duplication
        const { data: existUser, error: checkError } = await supabaseClient
            .from('tr_users')
            .select('id')
            .eq('username', username)
            .maybeSingle();

        if (checkError) throw checkError;

        if (existUser) {
            showToast('⚠️ 이미 존재하는 아이디입니다.', 'danger');
            showLoading(false);
            return;
        }

        // Insert new user
        const { data: newUser, error: insertError } = await supabaseClient
            .from('tr_users')
            .insert({ username, name, password, role: 'user' })
            .select()
            .single();

        if (insertError) throw insertError;

        if (newUser) {
            currentUser = {
                id: newUser.id,
                username: newUser.username,
                name: newUser.name,
                role: newUser.role
            };
            localStorage.setItem('youns_tr_user', JSON.stringify(currentUser));
            renderUserInterface();
            closeModal('login-modal');
            showToast(`🎉 회원가입 성공! 환영합니다.`);
            document.getElementById('signup-form').reset();
        }
    } catch (err) {
        console.error('회원가입 오류:', err);
        showToast('회원가입 처리 중 오류 발생', 'danger');
    } finally {
        showLoading(false);
    }
}

function handleLogout() {
    currentUser = null;
    localStorage.removeItem('youns_tr_user');
    renderUserInterface();
    showToast('🚪 로그아웃 되었습니다.');
}

// 6. Translation and Word Extraction Logic
async function executeTranslation() {
    const text = document.getElementById('source-text').value.trim();
    const sourceLang = document.getElementById('source-lang').value;
    const targetLang = document.getElementById('target-lang').value;

    // Validation: Require text or image
    if (!text && (!currentFile || !currentFile.base64Data)) {
        showToast('⚠️ 번역할 텍스트를 입력하거나 이미지 파일을 첨부해 주세요.', 'danger');
        return;
    }

    showLoading(true, currentFile && currentFile.mime_type.startsWith('image/') ? '이미지 문장 인식 및 번역 중...' : '번역 및 단어 추출 중...');

    try {
        const payload = {
            source_lang: sourceLang,
            target_lang: targetLang
        };

        if (currentFile && currentFile.mime_type.startsWith('image/')) {
            // Send image for multimodal Gemini processing
            payload.image = {
                mime_type: currentFile.mime_type,
                data: currentFile.base64Data
            };
        } else {
            payload.text = text;
        }

        const response = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || '번역 요청 실패');
        }

        const result = await response.json();

        // 1. Render Results
        document.getElementById('target-text').value = result.translated_text;
        
        // If image was OCR-ed, write the detected text back to source textarea
        if (result.original_text && currentFile && currentFile.mime_type.startsWith('image/')) {
            document.getElementById('source-text').value = result.original_text;
            document.getElementById('current-char-count').innerText = result.original_text.length;
        }

        // Enable buttons
        document.getElementById('btn-copy').removeAttribute('disabled');
        document.getElementById('btn-tts').removeAttribute('disabled');

        // 2. Save Extracted Words to Database (Global wordbook - tr_global_words)
        extractedWords = result.words || [];
        
        if (extractedWords.length > 0 && supabaseClient) {
            // Map words to database structure: language, word, translation, kanji, furigana, base_form
            const dbWords = extractedWords.map(w => ({
                language: w.language,
                word: w.word.trim(),
                translation: w.translation.trim(),
                kanji: w.kanji || null,           // Japanese kanji
                furigana: w.furigana || null,     // Japanese furigana (reading)
                base_form: w.base_form || null    // Japanese verb base form
            }));

            // Insert into tr_global_words and ignore duplicate key conflicts (language, word)
            const { error: dbError } = await supabaseClient
                .from('tr_global_words')
                .insert(dbWords, { onConflict: 'language,word', ignoreDuplicates: true });

            if (dbError) {
                console.error('글로벌 단어 저장 오류:', dbError);
            }
        }

        // 3. Render Extracted Words list
        renderExtractedWordsList();

    } catch (err) {
        console.error('번역 처리 오류:', err);
        showToast(`🚨 ${err.message}`, 'danger');
    } finally {
        showLoading(false);
    }
}

function renderExtractedWordsList() {
    const section = document.getElementById('extracted-words-section');
    const grid = document.getElementById('extracted-words-grid');
    
    if (extractedWords.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    grid.innerHTML = '';

    extractedWords.forEach((wordObj, index) => {
        const card = document.createElement('div');
        card.className = 'word-card';
        card.dataset.index = index;

        // Build word display for Japanese: show kanji (furigana), base_form if different
        let wordDisplay = escapeHtml(wordObj.word);
        if (wordObj.language === 'Japanese' && wordObj.kanji) {
            // Show kanji with furigana
            wordDisplay = escapeHtml(wordObj.kanji);
            if (wordObj.furigana) {
                wordDisplay += `<br><span style="font-size: 0.85em; color: var(--text-secondary);">${escapeHtml(wordObj.furigana)}</span>`;
            }
            // Show base form if different from original
            if (wordObj.base_form && wordObj.base_form !== wordObj.word) {
                wordDisplay += `<br><span style="font-size: 0.8em; color: var(--text-muted);">(원형: ${escapeHtml(wordObj.base_form)})</span>`;
            }
        }

        card.innerHTML = `
            <div class="word-checkbox-wrapper">
                <input type="checkbox" id="chk-word-${index}" class="word-checkbox" data-index="${index}">
            </div>
            <div class="word-info">
                <span class="word-text">${wordDisplay}</span>
                <span class="word-trans">${escapeHtml(wordObj.translation)}</span>
                <span class="word-lang-badge">${escapeHtml(wordObj.language)}</span>
            </div>
        `;

        // Card click select utility
        card.addEventListener('click', (e) => {
            // Avoid double toggle if clicked checkbox itself
            if (e.target.classList.contains('word-checkbox')) return;
            
            const chk = card.querySelector('.word-checkbox');
            chk.checked = !chk.checked;
            card.classList.toggle('selected', chk.checked);
            updateAddWordsButtonState();
        });

        // Checkbox change listener
        const chk = card.querySelector('.word-checkbox');
        chk.addEventListener('change', () => {
            card.classList.toggle('selected', chk.checked);
        });

        grid.appendChild(card);
    });

    updateAddWordsButtonState();
}

function updateAddWordsButtonState() {
    const checkedBoxes = document.querySelectorAll('.word-checkbox:checked');
    const addBtn = document.getElementById('btn-add-to-my-words');
    addBtn.disabled = checkedBoxes.length === 0;
}

// 7. Add Words to User's Wordbook
async function addSelectedWordsToMyWordbook() {
    if (!currentUser) {
        showToast('🔑 로그인 후 나만의 단어장을 사용할 수 있습니다.', 'warning');
        openModal('login-modal');
        return;
    }

    if (!supabaseClient) return;

    const checkedBoxes = document.querySelectorAll('.word-checkbox:checked');
    const selectedIndices = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.index));
    const wordsToAdd = selectedIndices.map(idx => extractedWords[idx]);

    showLoading(true, '내 단어장에 단어 추가 중...');

    try {
        const userWords = wordsToAdd.map(w => ({
            user_id: currentUser.id,
            language: w.language,
            word: w.word.trim(),
            translation: w.translation.trim(),
            kanji: w.kanji || null,           // Japanese kanji
            furigana: w.furigana || null,     // Japanese furigana (reading)
            base_form: w.base_form || null    // Japanese verb base form
        }));

        // Insert into tr_user_words, ignore duplicate key conflict on (user_id, language, word)
        const { error } = await supabaseClient
            .from('tr_user_words')
            .insert(userWords, { onConflict: 'user_id,language,word', ignoreDuplicates: true });

        if (error) throw error;

        showToast(`⭐ 선택한 ${wordsToAdd.length}개 단어가 '나만의 단어장'에 저장되었습니다.`);
        
        // Reset checkbox states
        checkedBoxes.forEach(cb => {
            cb.checked = false;
            cb.closest('.word-card').classList.remove('selected');
        });
        updateAddWordsButtonState();

    } catch (err) {
        console.error('단어 저장 에러:', err);
        showToast('단어 저장 중 오류가 발생했습니다. (이미 저장된 단어일 수 있습니다)', 'danger');
    } finally {
        showLoading(false);
    }
}

// 8. Wordbook Load / Read UI Operations
let localMyWords = []; // Cache list for front-end searches
async function loadMyWordbook() {
    if (!currentUser || !supabaseClient) return;

    const langFilter = document.getElementById('my-wordbook-lang').value;
    const tbody = document.getElementById('my-wordbook-tbody');
    const emptyState = document.getElementById('my-wordbook-empty');

    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">단어를 가져오는 중...</td></tr>';
    emptyState.style.display = 'none';

    try {
        let query = supabaseClient
            .from('tr_user_words')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (langFilter !== 'all') {
            query = query.eq('language', langFilter);
        }

        const { data, error } = await query;
        if (error) throw error;

        localMyWords = data || [];
        renderMyWordbookTable(localMyWords);
    } catch (err) {
        console.error('내 단어장 로드 오류:', err);
        showToast('내 단어장을 불러오는 데 실패했습니다.', 'danger');
    }
}

function renderMyWordbookTable(words) {
    const tbody = document.getElementById('my-wordbook-tbody');
    const emptyState = document.getElementById('my-wordbook-empty');
    
    tbody.innerHTML = '';
    
    if (words.length === 0) {
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

    words.forEach(w => {
        const tr = document.createElement('tr');
        tr.dataset.wordId = w.id;
        
        // For Japanese: show kanji, furigana separately
        let wordContent = escapeHtml(w.word);
        if (w.language === 'Japanese' && w.kanji) {
            wordContent = `<strong>${escapeHtml(w.kanji)}</strong>`;
            if (w.furigana) {
                wordContent += `<br><span style="font-size: 0.9em; color: var(--text-secondary);">${escapeHtml(w.furigana)}</span>`;
            }
        }
        
        // Show base_form if it's a verb conjugation
        let baseFormContent = '';
        if (w.base_form && w.base_form !== w.word) {
            baseFormContent = `<br><span style="font-size: 0.85em; color: var(--text-muted);">원형: ${escapeHtml(w.base_form)}</span>`;
        }

        tr.innerHTML = `
            <td><span class="word-lang-badge">${escapeHtml(w.language)}</span></td>
            <td class="col-word">${wordContent}${baseFormContent}</td>
            <td class="col-translation">${escapeHtml(w.translation)}</td>
            <td>
                <div class="wordbook-action-btns">
                    <button class="btn btn-edit-word" onclick="showWordEditModal(${w.id}, '${escapeHtml(w.language)}', '${escapeHtml(w.word)}', '${escapeHtml(w.translation)}', 'my')">✏️</button>
                    <button class="btn btn-danger" onclick="deleteUserWord(${w.id})">🗑️</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function filterMyWordbook() {
    const query = document.getElementById('my-wordbook-search').value.toLowerCase().trim();
    if (!query) {
        renderMyWordbookTable(localMyWords);
        return;
    }

    const filtered = localMyWords.filter(w => 
        w.word.toLowerCase().includes(query) || 
        w.translation.toLowerCase().includes(query)
    );
    renderMyWordbookTable(filtered);
}

// Global Wordbook Load / Read UI Operations
let localGlobalWords = [];
async function loadGlobalWordbook() {
    if (!supabaseClient) return;

    const langFilter = document.getElementById('global-wordbook-lang').value;
    const tbody = document.getElementById('global-wordbook-tbody');
    const emptyState = document.getElementById('global-wordbook-empty');

    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">단어를 가져오는 중...</td></tr>';
    emptyState.style.display = 'none';

    try {
        let query = supabaseClient
            .from('tr_global_words')
            .select('*')
            .order('created_at', { ascending: false });

        if (langFilter !== 'all') {
            query = query.eq('language', langFilter);
        }

        const { data, error } = await query;
        if (error) throw error;

        localGlobalWords = data || [];
        renderGlobalWordbookTable(localGlobalWords);
    } catch (err) {
        console.error('전체 단어장 로드 오류:', err);
        showToast('전체 단어장을 불러오는 데 실패했습니다.', 'danger');
    }
}

function renderGlobalWordbookTable(words) {
    const tbody = document.getElementById('global-wordbook-tbody');
    const emptyState = document.getElementById('global-wordbook-empty');
    
    tbody.innerHTML = '';
    
    if (words.length === 0) {
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.username === 'admin_tr');

    words.forEach(w => {
        const tr = document.createElement('tr');
        tr.dataset.wordId = w.id;
        
        // For Japanese: show kanji, furigana separately
        let wordContent = escapeHtml(w.word);
        if (w.language === 'Japanese' && w.kanji) {
            wordContent = `<strong>${escapeHtml(w.kanji)}</strong>`;
            if (w.furigana) {
                wordContent += `<br><span style="font-size: 0.9em; color: var(--text-secondary);">${escapeHtml(w.furigana)}</span>`;
            }
        }
        
        // Show base_form if it's a verb conjugation
        let baseFormContent = '';
        if (w.base_form && w.base_form !== w.word) {
            baseFormContent = `<br><span style="font-size: 0.85em; color: var(--text-muted);">원형: ${escapeHtml(w.base_form)}</span>`;
        }
        
        let actionButtons = '';
        if (isAdmin) {
            actionButtons = `
                <div class="wordbook-action-btns">
                    <button class="btn btn-edit-word" onclick="showWordEditModal(${w.id}, '${escapeHtml(w.language)}', '${escapeHtml(w.word)}', '${escapeHtml(w.translation)}', 'global')">✏️</button>
                    <button class="btn btn-danger" onclick="deleteGlobalWord(${w.id})">🗑️</button>
                </div>
            `;
        } else {
            actionButtons = `
                <button class="btn btn-primary" onclick="addSingleGlobalWordToMyWordbook(${w.id})">내 단어장에 추가</button>
            `;
        }

        tr.innerHTML = `
            <td><span class="word-lang-badge">${escapeHtml(w.language)}</span></td>
            <td class="col-word">${wordContent}${baseFormContent}</td>
            <td class="col-translation">${escapeHtml(w.translation)}</td>
            <td>${actionButtons}</td>
        `;
        tbody.appendChild(tr);
    });
}

function filterGlobalWordbook() {
    const query = document.getElementById('global-wordbook-search').value.toLowerCase().trim();
    if (!query) {
        renderGlobalWordbookTable(localGlobalWords);
        return;
    }

    const filtered = localGlobalWords.filter(w => 
        w.word.toLowerCase().includes(query) || 
        w.translation.toLowerCase().includes(query)
    );
    renderGlobalWordbookTable(filtered);
}

// 9. Word CRUD Operations (User Wordbook Edit/Delete)
window.showWordEditModal = function(id, lang, word, trans, source) {
    document.getElementById('edit-word-id').value = id;
    document.getElementById('edit-word-source').value = source;
    document.getElementById('edit-word-lang').value = lang;
    document.getElementById('edit-word-text').value = word;
    document.getElementById('edit-word-trans').value = trans;
    openModal('edit-word-modal');
};

async function handleWordEditSubmit(e) {
    e.preventDefault();
    if (!supabaseClient) return;

    const id = document.getElementById('edit-word-id').value;
    const source = document.getElementById('edit-word-source').value;
    const word = document.getElementById('edit-word-text').value.trim();
    const translation = document.getElementById('edit-word-trans').value.trim();

    showLoading(true, '단어 수정 중...');

    try {
        const table = source === 'my' ? 'tr_user_words' : 'tr_global_words';
        
        const { error } = await supabaseClient
            .from(table)
            .update({ word, translation })
            .eq('id', id);

        if (error) throw error;

        showToast('✏️ 단어가 수정되었습니다.');
        closeModal('edit-word-modal');
        
        // Refresh appropriate view
        if (source === 'my') {
            await loadMyWordbook();
        } else {
            await loadGlobalWordbook();
        }
    } catch (err) {
        console.error('단어 수정 에러:', err);
        showToast('단어 수정에 실패했습니다.', 'danger');
    } finally {
        showLoading(false);
    }
}

window.deleteUserWord = async function(id) {
    if (!supabaseClient) return;
    if (!confirm('정말 이 단어를 삭제하시겠습니까?')) return;

    showLoading(true, '단어 삭제 중...');
    try {
        const { error } = await supabaseClient
            .from('tr_user_words')
            .delete()
            .eq('id', id);

        if (error) throw error;

        showToast('🗑️ 단어가 삭제되었습니다.');
        await loadMyWordbook();
    } catch (err) {
        console.error('단어 삭제 에러:', err);
        showToast('단어 삭제 실패', 'danger');
    } finally {
        showLoading(false);
    }
};

// Global Wordbook Admin Actions (Edit/Delete)
window.deleteGlobalWord = async function(id) {
    if (!supabaseClient) return;
    if (!confirm('정말 전체 단어장에서 이 단어를 삭제하시겠습니까?\n(해당 언어의 번역 추출 목록에서 영구 삭제됩니다)')) return;

    showLoading(true, '단어 삭제 중...');
    try {
        const { error } = await supabaseClient
            .from('tr_global_words')
            .delete()
            .eq('id', id);

        if (error) throw error;

        showToast('🗑️ 전체 단어장에서 단어가 삭제되었습니다.');
        await loadGlobalWordbook();
    } catch (err) {
        console.error('글로벌 단어 삭제 에러:', err);
        showToast('단어 삭제 실패', 'danger');
    } finally {
        showLoading(false);
    }
};

window.addSingleGlobalWordToMyWordbook = async function(globalWordId) {
    if (!currentUser) {
        showToast('🔑 로그인 후 나만의 단어장을 사용할 수 있습니다.', 'warning');
        openModal('login-modal');
        return;
    }

    const gWord = localGlobalWords.find(w => w.id === globalWordId);
    if (!gWord || !supabaseClient) return;

    showLoading(true, '내 단어장에 단어 추가 중...');
    try {
        const userWord = {
            user_id: currentUser.id,
            language: gWord.language,
            word: gWord.word,
            translation: gWord.translation,
            kanji: gWord.kanji || null,           // Japanese kanji
            furigana: gWord.furigana || null,     // Japanese furigana
            base_form: gWord.base_form || null    // Japanese verb base form
        };

        const { error } = await supabaseClient
            .from('tr_user_words')
            .insert(userWord, { onConflict: 'user_id,language,word', ignoreDuplicates: true });

        if (error) throw error;

        showToast(`⭐ '${gWord.word}'가 내 단어장에 저장되었습니다.`);
    } catch (err) {
        console.error('글로벌 단어 추가 에러:', err);
        showToast('단어 추가 실패 (이미 존재할 수 있음)', 'danger');
    } finally {
        showLoading(false);
    }
};

// 10. UI Utilities
window.openModal = function(modalId) {
    document.getElementById(modalId).classList.add('active');
};

window.closeModal = function(modalId) {
    document.getElementById(modalId).classList.remove('active');
};

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    
    // Reset background styles
    toast.style.background = type === 'danger' ? 'rgba(239, 68, 68, 0.95)' : 
                             type === 'warning' ? 'rgba(245, 158, 11, 0.95)' : 'rgba(33, 22, 50, 0.95)';
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showLoading(show, text = '처리 중...') {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    if (show) {
        loadingText.innerText = text;
        overlay.style.display = 'flex';
    } else {
        overlay.style.display = 'none';
    }
}

function escapeHtml(string) {
    return String(string)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// 11. Excel Download Utility
function downloadWordbookAsExcel(words, filename) {
    if (words.length === 0) {
        showToast('📊 다운로드할 단어가 없습니다.', 'warning');
        return;
    }

    // Create CSV content with BOM for proper Excel encoding
    let csvContent = '\uFEFF'; // UTF-8 BOM
    
    // Header row
    csvContent += '언어\t단어/한자\t요미가나\t동사원형\t뜻(한국어)\t생성일\n';
    
    // Data rows
    words.forEach(w => {
        const kanji = w.kanji ? w.kanji : '';
        const furigana = w.furigana ? w.furigana : '';
        const baseForm = w.base_form ? w.base_form : '';
        const createdDate = w.created_at ? new Date(w.created_at).toLocaleDateString('ko-KR') : '';
        
        csvContent += `${w.language}\t${w.word}\t${kanji}\t${furigana}\t${baseForm}\t${w.translation}\t${createdDate}\n`;
    });

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename.replace('.xlsx', '.csv'));
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast(`📊 '${filename}'가 다운로드되었습니다.`);
}

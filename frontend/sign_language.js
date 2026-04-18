//
// ─── SIGN LANGUAGE MODE — MuTeX ──────────────────────────────────────────────
// Two-mode design: CAPTURE (camera→math) then SIGN (camera→hands)
// Does not use SpeechRecognition. Does not use Polly. Text-only output.
//
// Reads from script.js globals (read-only): API_URL, window.userProfile, window.MathJax
// Writes to no globals defined in script.js.
//

// Suppress MediaPipe's internal WebGL alert dialog — it falls back to CPU automatically.
// Without this, Chrome on 127.0.0.1 shows a blocking popup every time MediaPipe
// can't create a GPU context. We log it to console instead.
(function () {
    const _alert = window.alert.bind(window);
    window.alert = function (msg) {
        if (typeof msg === 'string' && msg.toLowerCase().includes('webgl')) {
            console.warn('[MediaPipe WebGL fallback]', msg);
            return;
        }
        _alert(msg);
    };
}());

// ── State ────────────────────────────────────────────────────────────────────

const SL = {
    mode:             'idle',      // idle | captured | signing | answered
    capturedImageB64: null,        // base64 PNG of the math problem photo
    capturedLatex:    '',          // LaTeX extracted in capture step
    letterBuffer:     [],          // accumulated letters this word
    wordBuffer:       [],          // accumulated words this sentence
    lastSignTime:     0,           // timestamp of last detected sign
    pauseThreshold:   1500,        // ms silence before inserting space
    doneThreshold:    99999,       // effectively disabled — only Enter/Send submits
    detector:         null,        // @tensorflow-models/hand-pose-detection Detector
    signVideo:        null,        // <video> element for sign mode
    overlayCanvas:    null,        // <canvas> for landmark drawing
    signContext:      [],          // conversation context (max 4 turns)
    frameCount:       0,           // total onHandResults calls (for diagnostics)
    lastLetter:       '',          // debounce repeated detections
    lastLetterCount:  0,
    minLetterFrames:  5,           // must see same letter N frames before accepting
    _lastSendError:   null,        // dedup repeated estimateHands error logs
    _loopActive:      false,
};

// ── ASL Fingerspelling Classifier ────────────────────────────────────────────
// Landmark indices: 0=wrist, 1-4=thumb, 5-8=index, 9-12=middle,
//                  13-16=ring, 17-20=pinky

function classifyASL(landmarks) {
    if (!landmarks || landmarks.length < 21) return null;

    // Guard: NaN from a corrupt or partially-loaded model frame
    if (!landmarks[0] || isNaN(landmarks[0].x) || isNaN(landmarks[0].y)) return null;
    if (isNaN(landmarks[4].x) || isNaN(landmarks[8].x))                  return null;

    // Guard: palm scale sanity — hand must occupy some space in frame
    const rawPalmDx = landmarks[9].x - landmarks[0].x;
    const rawPalmDy = landmarks[9].y - landmarks[0].y;
    if (Math.sqrt(rawPalmDx*rawPalmDx + rawPalmDy*rawPalmDy) < 0.01)    return null;

    // STEP 1: Normalize relative to wrist — removes position variance.
    const wrist = landmarks[0];
    const norm = landmarks.map(lm => ({
        x: lm.x - wrist.x,
        y: lm.y - wrist.y,
    }));

    // NOTE: estimateHands(flipHorizontal:true) already returns mirror-space
    // coordinates — no additional x-flip needed. thumbRight/Left are correct
    // relative to what the user sees in the CSS-mirrored video.

    // STEP 3: Scale by palm size for camera-distance invariance.
    const palmScale = Math.sqrt(
        norm[9].x * norm[9].x + norm[9].y * norm[9].y
    ) || 1;
    norm.forEach(lm => { lm.x /= palmScale; lm.y /= palmScale; });

    // STEP 4: Angle-based finger curl — robust to any hand orientation.
    // Angle at PIP joint. Straight finger ≈ 180°, curled ≈ small angle.
    function angle3(a, b, c) {
        const v1 = { x: a.x - b.x, y: a.y - b.y };
        const v2 = { x: c.x - b.x, y: c.y - b.y };
        const dot = v1.x * v2.x + v1.y * v2.y;
        const mag = Math.sqrt((v1.x*v1.x + v1.y*v1.y) * (v2.x*v2.x + v2.y*v2.y));
        if (mag === 0) return 180;
        return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
    }

    const EXTEND = 150;   // ° above = extended
    const CURL   = 100;   // ° below = curled

    const indexAngle  = angle3(norm[5],  norm[6],  norm[8]);
    const middleAngle = angle3(norm[9],  norm[10], norm[12]);
    const ringAngle   = angle3(norm[13], norm[14], norm[16]);
    const pinkyAngle  = angle3(norm[17], norm[18], norm[20]);

    const index  = indexAngle  > EXTEND;
    const middle = middleAngle > EXTEND;
    const ring   = ringAngle   > EXTEND;
    const pinky  = pinkyAngle  > EXTEND;

    const indexCurled  = indexAngle  < CURL;
    const middleCurled = middleAngle < CURL;
    const ringCurled   = ringAngle   < CURL;
    const pinkyCurled  = pinkyAngle  < CURL;

    // STEP 5: Thumb direction in flipped/mirror space.
    const thumbDx    = norm[4].x - norm[2].x;
    const thumbRight = thumbDx > 0.3;
    const thumbLeft  = thumbDx < -0.3;
    const thumbUp    = norm[4].y < norm[2].y - 0.2;

    // STEP 6: Scale-invariant tip distances.
    function ndist(i, j) {
        const dx = norm[i].x - norm[j].x, dy = norm[i].y - norm[j].y;
        return Math.sqrt(dx*dx + dy*dy);
    }

    const thumbIndexClose  = ndist(4, 8)  < 0.4;
    const thumbMiddleClose = ndist(4, 12) < 0.4;
    const imSpread         = Math.abs(norm[8].x - norm[12].x) > 0.3;

    const allCurled   = indexCurled  && middleCurled && ringCurled && pinkyCurled;
    const allExtended = index && middle && ring && pinky;

    // ── Classifier — most specific first ─────────────────────────────────────

    // L — index up, thumb out sideways (THE KEY FIX: flipped x makes this work)
    if (index && !middle && !ring && !pinky &&
        (thumbRight || thumbLeft) && !thumbUp)                            return 'L';

    // Y — pinky + thumb sideways
    if (!index && !middle && !ring && pinky &&
        (thumbRight || thumbLeft))                                        return 'Y';

    // A — fist with thumb to side
    if (allCurled && (thumbRight || thumbLeft) && !thumbUp)               return 'A';

    // E — all curled, thumb tucked (no lateral thumb)
    if (allCurled && !thumbRight && !thumbLeft && !thumbUp)               return 'E';

    // B — all four fingers extended, thumb not out
    if (allExtended && !thumbRight && !thumbLeft)                         return 'B';

    // SPACE — open flat palm with thumb
    if (allExtended && (thumbRight || thumbLeft || thumbUp))              return 'SPACE';

    // W — index + middle + ring
    if (index && middle && ring && !pinky)                                return 'W';

    // V — index + middle spread
    if (index && middle && !ring && !pinky && imSpread)                   return 'V';

    // K — index + middle + thumb up
    if (index && middle && !ring && !pinky && thumbUp)                    return 'K';

    // U — index + middle together (not spread)
    if (index && middle && !ring && !pinky && !imSpread)                  return 'U';

    // I — pinky only
    if (!index && !middle && !ring && pinky)                              return 'I';

    // F — thumb + index pinch, others up
    if (thumbIndexClose && !index && middle && ring && pinky)             return 'F';

    // O — thumb + index + middle form circle
    if (thumbIndexClose && thumbMiddleClose && !allExtended)              return 'O';

    // D — index up, thumb touches middle base
    if (index && !middle && !ring && !pinky && thumbMiddleClose)          return 'D';

    // G — index points sideways (x dominates)
    if (index && !middle && !ring && !pinky &&
        Math.abs(norm[8].x) > Math.abs(norm[8].y) * 1.5)                 return 'G';

    // X — index hooked (between curl and extend)
    if (indexAngle > CURL && indexAngle < EXTEND &&
        middleCurled && ringCurled && pinkyCurled)                        return 'X';

    // Z — index up, no thumb extension
    if (index && !middle && !ring && !pinky &&
        !thumbRight && !thumbLeft)                                         return 'Z';

    // S — fist, thumb over (tip near index base)
    if (allCurled && thumbUp)                                             return 'S';

    // N — LAST: only fires when angles explicitly confirm curl (not just when booleans fail)
    // This prevents NaN or borderline frames from being misclassified as N.
    if (indexAngle < CURL && middleAngle < CURL &&
        !thumbRight && !thumbLeft && !thumbUp)                            return 'N';

    return null;
}

// ── Letter accumulation ───────────────────────────────────────────────────────

function acceptLetter(letter) {
    if (!letter) {
        SL.lastLetter = '';
        SL.lastLetterCount = 0;
        return;
    }

    if (letter === SL.lastLetter) {
        SL.lastLetterCount++;
    } else {
        SL.lastLetter = letter;
        SL.lastLetterCount = 1;
        return;
    }

    // Accept only after minLetterFrames consecutive identical frames
    if (SL.lastLetterCount !== SL.minLetterFrames) return;

    SL.lastLetterCount = 0;
    SL.lastLetter = '';
    SL.lastSignTime = Date.now();

    if (letter === 'SPACE') {
        flushLetterBuffer();
        return;
    }

    SL.letterBuffer.push(letter);
    updateSignDisplay();
}

function flushLetterBuffer() {
    if (SL.letterBuffer.length === 0) return;
    SL.wordBuffer.push(SL.letterBuffer.join(''));
    SL.letterBuffer = [];
    updateSignDisplay();
}

function getCurrentSentence() {
    const words = [...SL.wordBuffer];
    if (SL.letterBuffer.length > 0) words.push(SL.letterBuffer.join(''));
    return words.join(' ');
}

function updateSignDisplay() {
    const sentence = getCurrentSentence();
    const el = document.getElementById('sl-live-text');
    if (el) el.textContent = sentence || '…';

    const submitBtn = document.getElementById('sl-submit-btn');
    if (submitBtn) submitBtn.disabled = sentence.trim().length === 0;
}

// ── Pause / auto-submit detection ────────────────────────────────────────────

let pauseCheckInterval = null;

function startPauseDetection() {
    pauseCheckInterval = setInterval(() => {
        if (SL.mode !== 'signing') return;
        const elapsed = Date.now() - SL.lastSignTime;

        // 2 s pause → flush current letters into a word
        if (elapsed > SL.pauseThreshold && SL.letterBuffer.length > 0) {
            flushLetterBuffer();
        }
        // Auto-submit intentionally removed — user presses Enter or the Send button
    }, 300);
}

function stopPauseDetection() {
    if (pauseCheckInterval) { clearInterval(pauseCheckInterval); pauseCheckInterval = null; }
}

// ── Hand detection initialisation (TF.js — works reliably in Chrome) ─────────
//
// Uses @tensorflow-models/hand-pose-detection with runtime:'tfjs'.
// No MediaPipe CDN / WASM required — model weights come from TF Hub.
// Same 21-landmark format as MediaPipe, so classifyASL() is unchanged.

async function initMediaPipe() {
    if (SL.detector) return;   // already ready

    if (typeof handPoseDetection === 'undefined' || typeof tf === 'undefined') {
        console.error('[SL] TF.js or hand-pose-detection CDN scripts not loaded');
        setSLStatus('Hand detection unavailable — check internet connection');
        return;
    }

    setSLStatus('Loading hand detection model…');

    // Wait for TF.js to pick the best available backend (WebGL → WASM → CPU)
    try {
        await tf.ready();
        console.log('[SL] TF.js backend:', tf.getBackend());
    } catch (e) {
        console.warn('[SL] tf.ready() warning:', e.message);
    }

    try {
        SL.detector = await handPoseDetection.createDetector(
            handPoseDetection.SupportedModels.MediaPipeHands,
            {
                runtime:   'tfjs',   // pure TF.js — no separate MediaPipe CDN
                modelType: 'lite',   // fastest; same accuracy for fingerspelling
                maxHands:  1,
            }
        );
        console.log('[SL] Hand detector ready ✓');
        setSLStatus('Hand detection ready — tap "Ask about this"');
    } catch (e) {
        console.error('[SL] createDetector failed:', e);
        setSLStatus('Hand detection failed — ' + e.message.slice(0, 80));
        SL.detector = null;
    }
}

// Fallback landmark renderer when drawing_utils.js isn't available
function _drawLandmarksFallback(ctx, landmarks) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // Draw connections manually using the 21-landmark hand topology
    const connections = [
        [0,1],[1,2],[2,3],[3,4],          // thumb
        [0,5],[5,6],[6,7],[7,8],           // index
        [5,9],[9,10],[10,11],[11,12],      // middle
        [9,13],[13,14],[14,15],[15,16],    // ring
        [13,17],[17,18],[18,19],[19,20],   // pinky
        [0,17]                             // palm
    ];
    ctx.strokeStyle = '#1D9E75';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    for (const [a, b] of connections) {
        const la = landmarks[a], lb = landmarks[b];
        if (!la || !lb) continue;
        ctx.moveTo(la.x * w, la.y * h);
        ctx.lineTo(lb.x * w, lb.y * h);
    }
    ctx.stroke();

    ctx.fillStyle = '#7F77DD';
    for (const lm of landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2);
        ctx.fill();
    }
}

function onHandResults(results) {
    if (SL.mode !== 'signing') return;

    // Guard: no landmarks present — clear canvas and return
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        if (SL.overlayCanvas) {
            const ctx = SL.overlayCanvas.getContext('2d');
            ctx.clearRect(0, 0, SL.overlayCanvas.width, SL.overlayCanvas.height);
        }
        const debugEl = document.getElementById('sl-debug');
        if (debugEl) debugEl.textContent = 'No hand detected';
        return;
    }

    const lm = results.multiHandLandmarks[0];

    // Guard: NaN coordinates = model data corrupt, skip frame entirely
    if (!lm[0] || isNaN(lm[0].x) || isNaN(lm[4].x) || isNaN(lm[8].x)) {
        const debugEl = document.getElementById('sl-debug');
        if (debugEl) debugEl.textContent = 'Bad frame (NaN) — skipped';
        return;
    }

    if (SL.overlayCanvas) {
        const ctx = SL.overlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, SL.overlayCanvas.width, SL.overlayCanvas.height);
        _drawLandmarksFallback(ctx, lm);
    }

    // REMOVE BEFORE FINAL DEMO — debug display
    const debugEl = document.getElementById('sl-debug');
    if (debugEl) {
        const letter = classifyASL(lm);
        const thumbDx = lm[4].x - lm[0].x;  // mirror-space (flipHorizontal:true applied)
        debugEl.textContent =
            `letter: ${letter ?? 'null'} | thumbDx: ${thumbDx.toFixed(3)} | ` +
            `idx8y: ${lm[8].y.toFixed(3)} pip6y: ${lm[6].y.toFixed(3)}`;
    }
}

// ── Camera control ────────────────────────────────────────────────────────────

async function startSignCamera() {
    SL.signVideo     = document.getElementById('sl-video');
    SL.overlayCanvas = document.getElementById('sl-canvas');
    if (!SL.signVideo || !SL.overlayCanvas) {
        console.error('[SL] sl-video or sl-canvas not found');
        return;
    }

    await initMediaPipe();
    if (!SL.detector) return;

    try {
        const camStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' }
        });
        SL.signVideo.srcObject = camStream;

        await new Promise(resolve => {
            if (SL.signVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
                SL.signVideo.play().then(resolve).catch(resolve);
            } else {
                SL.signVideo.onloadedmetadata = () =>
                    SL.signVideo.play().then(resolve).catch(resolve);
            }
        });

        const w = SL.signVideo.videoWidth  || 640;
        const h = SL.signVideo.videoHeight || 480;

        // Size canvas to match video — video stays visible, canvas overlays on top
        SL.overlayCanvas.width  = w;
        SL.overlayCanvas.height = h;

        // Offscreen canvas for model input: TF.js reads from a plain canvas element,
        // NOT from the CSS-transformed video element. Passing the CSS-mirrored video
        // directly to estimateHands causes tf.browser.fromPixels() to receive garbage
        // GPU texture data → every keypoint x/y = NaN. Drawing to a 2D canvas first
        // gives TF.js a clean, correctly-decoded RGB frame.
        const inputCanvas  = document.createElement('canvas');
        inputCanvas.width  = w;
        inputCanvas.height = h;
        const inputCtx     = inputCanvas.getContext('2d');

        console.log('[SL] Camera ready:', w, 'x', h);
        setSLStatus('Show your hand and fingerspell your question');

        // Verify model is producing valid output after 2s.
        // If keypoints are still NaN, show the typing fallback.
        setTimeout(async () => {
            if (!SL.signVideo || SL.signVideo.readyState < 2) return;
            try {
                inputCtx.drawImage(SL.signVideo, 0, 0, w, h);
                const testResult = await SL.detector.estimateHands(inputCanvas, { flipHorizontal: true });
                if (testResult.length > 0 && isNaN(testResult[0].keypoints[0].x)) {
                    throw new Error('Model returned NaN keypoints even after offscreen canvas fix');
                }
                console.log('[SL] Model verified — hand detection active');
            } catch (err) {
                console.error('[SL] Model verification failed:', err);
                setSLStatus('Hand detection unavailable — type your question below');
                showTypingFallback();
            }
        }, 2500);

        let loopFrames = 0;
        SL._loopActive = true;

        async function frameLoop() {
            if (!SL._loopActive || SL.mode !== 'signing') return;

            if (SL.signVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                try {
                    // Draw raw video frame (no CSS transforms) to offscreen canvas,
                    // then pass that canvas to TF.js. This avoids GPU texture NaN.
                    inputCtx.drawImage(SL.signVideo, 0, 0, w, h);

                    // flipHorizontal:true → mirror-space coords (matches CSS scaleX(-1) on video)
                    const detected = await SL.detector.estimateHands(inputCanvas, {
                        flipHorizontal: true
                    });

                    if (detected.length > 0) {
                        const kp = detected[0].keypoints;
                        // Validate first keypoint — NaN means model weights not loaded yet
                        if (!isNaN(kp[0].x) && !isNaN(kp[0].y)) {
                            const norm = kp.map(p => ({ x: p.x / w, y: p.y / h }));
                            onHandResults({ multiHandLandmarks: [norm] });
                            SL.frameCount++;
                            if (SL.frameCount % 2 === 0) {
                                const letter = classifyASL(norm);
                                if (letter) acceptLetter(letter);
                            }
                        } else {
                            onHandResults({ multiHandLandmarks: [] });
                        }
                    } else {
                        onHandResults({ multiHandLandmarks: [] });
                    }
                } catch (e) {
                    if (e.message !== SL._lastSendError) {
                        console.warn('[SL] estimateHands error:', e.message);
                        SL._lastSendError = e.message;
                    }
                }
            }

            loopFrames++;
            if (loopFrames === 1)  console.log('[SL] Frame loop running ✓');
            if (loopFrames === 30) console.log('[SL] 30 frames, detections:', SL.frameCount);

            requestAnimationFrame(frameLoop);
        }

        requestAnimationFrame(frameLoop);

    } catch (err) {
        console.error('[SL] Camera start error:', err);
        setSLStatus('Camera error: ' + (err.message || 'permission denied'));
    }
}

function stopSignCamera() {
    SL._loopActive = false;
    if (SL.overlayCanvas) {
        const ctx = SL.overlayCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, SL.overlayCanvas.width, SL.overlayCanvas.height);
    }
    if (SL.signVideo && SL.signVideo.srcObject) {
        SL.signVideo.srcObject.getTracks().forEach(t => t.stop());
        SL.signVideo.srcObject = null;
    }
}

// ── Mode transitions ──────────────────────────────────────────────────────────

function setSLMode(mode) {
    SL.mode = mode;

    const captureSection  = document.getElementById('sl-capture-section');
    const capturedSection = document.getElementById('sl-captured-section');
    const signingSection  = document.getElementById('sl-signing-section');
    const answerSection   = document.getElementById('sl-answer-section');

    if (captureSection)  captureSection.hidden  = (mode !== 'idle');
    if (capturedSection) capturedSection.hidden  = (mode === 'idle' || mode === 'signing');
    if (signingSection)  signingSection.hidden   = (mode !== 'signing');
    if (answerSection)   answerSection.hidden    = (mode !== 'answered');

    if (mode === 'signing') {
        SL.letterBuffer  = [];
        SL.wordBuffer    = [];
        SL.lastSignTime  = Date.now();
        SL.frameCount    = 0;
        SL.lastLetter    = '';
        SL.lastLetterCount = 0;
        updateSignDisplay();
        startPauseDetection();
        startSignCamera();
        setSLStatus('Show your hand and fingerspell your question');
    } else {
        stopPauseDetection();
        stopSignCamera();   // always clean up camera when leaving signing mode
    }

    if (mode === 'idle') {
        SL.capturedImageB64 = null;
        SL.capturedLatex    = '';
        SL.signContext      = [];
    }
}

// ── Capture step ──────────────────────────────────────────────────────────────

async function captureForSign() {
    // Find the math webcam video — look for id="camera" (our actual element)
    // then fall back to 'webcam' (spec name) then any visible video
    const mathVideo =
        document.getElementById('camera') ||
        document.getElementById('webcam') ||
        document.querySelector('video:not(#sl-video)');

    if (!mathVideo || !mathVideo.videoWidth) {
        setSLStatus('No camera stream active — start the camera first');
        return;
    }

    const canvas  = document.createElement('canvas');
    canvas.width  = mathVideo.videoWidth;
    canvas.height = mathVideo.videoHeight;
    canvas.getContext('2d').drawImage(mathVideo, 0, 0);

    const dataUrl = canvas.toDataURL('image/png');
    SL.capturedImageB64 = dataUrl.split(',')[1];   // strip data URL prefix

    // Show preview immediately
    const preview = document.getElementById('sl-preview-img');
    if (preview) preview.src = dataUrl;

    setSLStatus('Reading your math problem…');
    const captureBtn = document.getElementById('sl-capture-btn');
    if (captureBtn) captureBtn.disabled = true;

    try {
        // Get hearing profile for the analyze call
        const hearingProfile = await fetch(`${API_URL}/profile?disability=hearing`)
            .then(r => r.json())
            .catch(() => ({ disability: 'hearing', captions_only: true, voice_output: false }));

        // Convert base64 back to blob for multipart upload
        const binary = atob(SL.capturedImageB64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/png' });

        const form = new FormData();
        form.append('image',   blob, 'capture.png');
        form.append('profile', JSON.stringify(hearingProfile));

        const res  = await fetch(`${API_URL}/analyze`, { method: 'POST', body: form });
        const data = await res.json();

        SL.capturedLatex = data.latex || '';

        // Render captured LaTeX
        const latexEl = document.getElementById('sl-captured-latex');
        if (latexEl) {
            latexEl.textContent = SL.capturedLatex
                ? '\\(' + SL.capturedLatex + '\\)'
                : '(No math detected — try better lighting)';
            if (window.MathJax) MathJax.typesetPromise([latexEl]).catch(() => {});
        }

        setSLMode('captured');
        setSLStatus('Problem captured! Click "Ask about this" and sign your question.');

    } catch (err) {
        console.error('Capture error:', err);
        setSLStatus('Could not read problem — try better lighting or repositioning');
        if (captureBtn) captureBtn.disabled = false;
    }
}

// ── Submit signed question ────────────────────────────────────────────────────

async function submitSignedQuestion() {
    flushLetterBuffer();
    const sentence = getCurrentSentence().trim();
    if (!sentence) {
        setSLStatus('No text detected — please fingerspell your question');
        return;
    }

    stopPauseDetection();
    stopSignCamera();
    setSLStatus('Thinking…');

    const submitBtn = document.getElementById('sl-submit-btn');
    if (submitBtn) submitBtn.disabled = true;

    const hearingProfile = {
        disability:    'hearing',
        captions_only: true,
        voice_output:  false,
        voice_input:   false,
    };

    try {
        const res = await fetch(`${API_URL}/sign`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                image_b64:   SL.capturedImageB64 || '',
                signed_text: sentence,
                profile:     hearingProfile,
                context:     SL.signContext.slice(-4),
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        handleSignResponse(data, sentence);

    } catch (err) {
        console.error('/sign error:', err);
        setSLStatus('Error — please try again');
        setSLMode('signing');
    }
}

function handleSignResponse(data, originalSentence) {
    const answerEl = document.getElementById('sl-answer-text');
    if (answerEl) answerEl.textContent = data.answer;

    const signedEl = document.getElementById('sl-signed-echo');
    if (signedEl) signedEl.textContent = 'You signed: ' + originalSentence;

    const latexEl = document.getElementById('sl-answer-latex');
    if (latexEl) {
        if (data.latex) {
            latexEl.textContent = '\\(' + data.latex + '\\)';
            if (window.MathJax) MathJax.typesetPromise([latexEl]).catch(() => {});
            latexEl.hidden = false;
        } else {
            latexEl.hidden = true;
        }
    }

    // Update context for follow-up questions (max 4 turns = 8 items)
    SL.signContext.push(
        { role: 'user',      content: originalSentence },
        { role: 'assistant', content: data.answer }
    );
    if (SL.signContext.length > 8) SL.signContext = SL.signContext.slice(-8);

    setSLMode('answered');
    setSLStatus('Answer ready. Sign another question or capture a new problem.');
}

// ── Delete last letter ────────────────────────────────────────────────────────

function slDeleteLast() {
    if (SL.letterBuffer.length > 0) {
        SL.letterBuffer.pop();
    } else if (SL.wordBuffer.length > 0) {
        const lastWord = SL.wordBuffer.pop();
        SL.letterBuffer = lastWord.split('');
        SL.letterBuffer.pop();
    }
    updateSignDisplay();
}

// ── UI helper ─────────────────────────────────────────────────────────────────

function setSLStatus(msg) {
    const el = document.getElementById('sl-status');
    if (el) el.textContent = msg;
}

// ── Keyboard support ──────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (SL.mode !== 'signing') return;
    if (e.key === 'Enter')     { e.preventDefault(); submitSignedQuestion(); }
    if (e.key === 'Backspace') { e.preventDefault(); slDeleteLast(); }
});

// ── Typing fallback (guarantees demo works if model fails to load) ────────────

function showTypingFallback() {
    const signingSection = document.getElementById('sl-signing-section');
    if (!signingSection) return;

    const existing = document.getElementById('sl-type-input');
    if (existing) return;  // already added

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-top:12px;';
    wrapper.innerHTML = `
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">
            Or type your question directly:
        </div>
        <div style="display:flex;gap:8px;">
            <input id="sl-type-input"
                   type="text"
                   placeholder="e.g. what is the integral of x squared"
                   style="flex:1;padding:10px;border-radius:8px;
                          border:0.5px solid #ccc;font-size:13px;
                          background:transparent;color:inherit;"
                   aria-label="Type your question about the math problem" />
            <button onclick="window.submitTypedQuestion()"
                    style="padding:10px 16px;border-radius:8px;
                           border:1.5px solid #1D9E75;color:#0F6E56;
                           background:transparent;cursor:pointer;
                           font-size:13px;font-weight:500;">
                Send
            </button>
        </div>
    `;
    signingSection.appendChild(wrapper);

    setTimeout(() => {
        const inp = document.getElementById('sl-type-input');
        if (inp) inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') window.submitTypedQuestion();
        });
    }, 100);
}

function submitTypedQuestion() {
    const inp = document.getElementById('sl-type-input');
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    inp.value = '';

    SL.wordBuffer   = text.split(' ');
    SL.letterBuffer = [];
    updateSignDisplay();
    submitSignedQuestion();
}

window.submitTypedQuestion = submitTypedQuestion;

// ── Init — called by applyProfile() in script.js ─────────────────────────────

window.slInit = function () {
    const profile = window.userProfile;
    const panel   = document.getElementById('sign-panel');
    if (!panel) return;

    if (profile &&
        (profile.disability === 'hearing' || profile.disability === 'multi')) {
        panel.hidden = false;
        // Preload model immediately so it's ready by the time signing starts
        if (!SL.detector) {
            initMediaPipe().catch(e => console.error('[SL] slInit preload failed:', e));
        }
    } else {
        panel.hidden = true;
    }
};

// ── Expose globals needed by inline HTML onclick handlers ─────────────────────
window.captureForSign       = captureForSign;
window.setSLMode            = setSLMode;
window.submitSignedQuestion = submitSignedQuestion;
window.slDeleteLast         = slDeleteLast;

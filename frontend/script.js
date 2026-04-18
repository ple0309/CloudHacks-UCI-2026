// Empty string = same-origin (Flask serves both frontend and API on port 5000).
const API_URL = document.querySelector('meta[name="api-url"]')?.content?.trim() || '';

// =============================================================================
// ─── CAMERA / ANALYZE STATE ──────────────────────────────────────────────────
// =============================================================================

let stream = null;
let intervalId = null;
let isAnalyzing = false;

let lastLatex = "";
let lastExplanation = "No explanation available yet.";
let lastConfidence = "";

const camera        = document.getElementById("camera");
const snapshot      = document.getElementById("snapshot");
const statusEl      = document.getElementById("status");
const latexEl       = document.getElementById("latexOutput");
const explanationEl = document.getElementById("explanationOutput");
const confidenceEl  = document.getElementById("confidenceOutput");
const renderedEl    = document.getElementById("renderedOutput");
const statusBadge   = document.getElementById("statusBadge");
const warningBanner = document.getElementById("warningBanner");
const ariaLive      = document.getElementById("ariaLive");
const startBtn      = document.getElementById("startBtn");
const stopBtn       = document.getElementById("stopBtn");
const voiceBtn      = document.getElementById("voiceBtn");

startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click",  stopCamera);
voiceBtn.addEventListener("click", speakResult);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clearConfidenceClasses(el) {
    el.classList.remove("conf-low", "conf-medium", "conf-high");
}
function applyConfidenceClass(el, confidence) {
    clearConfidenceClasses(el);
    if (confidence === "low")    el.classList.add("conf-low");
    else if (confidence === "medium") el.classList.add("conf-medium");
    else if (confidence === "high")   el.classList.add("conf-high");
}
function showWarning(msg)  { warningBanner.textContent = msg; warningBanner.hidden = false; }
function hideWarning()     { warningBanner.hidden = true; warningBanner.textContent = ""; }
function announceToScreenReader(text) { if (ariaLive) ariaLive.textContent = text; }

// ─── Camera ──────────────────────────────────────────────────────────────────

async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
        camera.srcObject = stream;
        statusEl.textContent = "Status: camera started";
        statusBadge.textContent = "live";
        clearConfidenceClasses(statusBadge);
        hideWarning();
        startAutoCapture();
    } catch (err) {
        console.error(err);
        statusEl.textContent = "Status: failed to access camera";
        statusBadge.textContent = "error";
        clearConfidenceClasses(statusBadge);
        showWarning("Camera access denied — please allow camera permissions and reload.");
    }
}

function stopCamera() {
    stopAutoCapture();
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    camera.srcObject = null;
    statusEl.textContent = "Status: camera stopped";
    statusBadge.textContent = "stopped";
    clearConfidenceClasses(statusBadge);
    hideWarning();
}

function startAutoCapture() {
    stopAutoCapture();
    intervalId = setInterval(() => {
        if (!isAnalyzing && stream) captureAndAnalyzeFrame();
    }, 2000);
}
function stopAutoCapture() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

function captureCurrentFrameBlob() {
    return new Promise(resolve => {
        const ctx = snapshot.getContext("2d");
        snapshot.width  = camera.videoWidth  || 640;
        snapshot.height = camera.videoHeight || 480;
        ctx.drawImage(camera, 0, 0, snapshot.width, snapshot.height);
        snapshot.toBlob(blob => resolve(blob), "image/png");
    });
}

/**
 * Capture the current camera frame as a base64 JPEG string (no prefix).
 * Used to send the board image alongside voice queries.
 * Returns null if the camera is not active.
 */
function captureFrameBase64() {
    if (!stream || !camera.videoWidth) return null;
    const cvs = document.createElement("canvas");
    // Cap at 640px wide — sufficient for Bedrock vision, keeps payload small
    cvs.width  = Math.min(camera.videoWidth, 640);
    cvs.height = Math.round(camera.videoHeight * cvs.width / camera.videoWidth);
    cvs.getContext("2d").drawImage(camera, 0, 0, cvs.width, cvs.height);
    const dataUrl = cvs.toDataURL("image/jpeg", 0.8);
    return dataUrl.split(",")[1];   // strip "data:image/jpeg;base64," prefix
}

// ─── Analyze ─────────────────────────────────────────────────────────────────

async function captureAndAnalyzeFrame() {
    if (!stream) return;
    isAnalyzing = true;
    statusEl.textContent = "Status: analyzing frame...";
    try {
        const blob = await captureCurrentFrameBlob();
        const formData = new FormData();
        formData.append("image", blob, "frame.png");
        if (userProfile) formData.append("profile", JSON.stringify(userProfile));

        const res = await fetch(`${API_URL}/analyze`, { method: "POST", body: formData });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = await res.json();

        if (!data.confidence || data.confidence === "low") {
            statusEl.textContent = "Status: low confidence, move closer";
            statusBadge.textContent = "low";
            confidenceEl.textContent = data.confidence || "low";
            applyConfidenceClass(statusBadge, "low");
            applyConfidenceClass(confidenceEl, "low");
            showWarning("Low confidence — please reposition camera");
            return;
        }

        hideWarning();
        if (data.latex !== lastLatex) {
            latexEl.textContent       = data.latex        || "";
            explanationEl.textContent = data.explanation  || "";
            confidenceEl.textContent  = data.confidence   || "";
            lastLatex       = data.latex        || "";
            lastExplanation = data.explanation  || lastExplanation;
            lastConfidence  = data.confidence   || "";
            applyConfidenceClass(confidenceEl, data.confidence);
            statusBadge.textContent = data.confidence;
            applyConfidenceClass(statusBadge, data.confidence);
            renderedEl.innerHTML = data.latex ? `$$${data.latex}$$` : "Waiting...";
            if (window.MathJax) MathJax.typesetPromise([renderedEl]).catch(console.error);
            announceToScreenReader(data.explanation || "");
            statusEl.textContent = "Status: updated";
            // Fire-and-forget — never blocks LaTeX rendering
            fetchRecommendations(lastLatex, lastExplanation);
        } else {
            statusEl.textContent = "Status: stable";
            statusBadge.textContent = lastConfidence || "stable";
            applyConfidenceClass(statusBadge, lastConfidence);
            applyConfidenceClass(confidenceEl, lastConfidence);
        }
    } catch (err) {
        console.error(err);
        statusEl.textContent = "Status: request failed";
        statusBadge.textContent = "error";
        clearConfidenceClasses(statusBadge);
        showWarning("Connection error — check that the backend is running.");
    } finally {
        isAnalyzing = false;
    }
}

// ─── Read Aloud (camera result) ───────────────────────────────────────────────

function speakResult() {
    const text = lastExplanation?.trim() || "No explanation available.";
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate  = userProfile?.tts_speed || 1;
    utterance.onstart = () => { statusEl.textContent = "Status: reading aloud"; };
    utterance.onend   = () => { statusEl.textContent = "Status: voice finished"; };
    utterance.onerror = () => { statusEl.textContent = "Status: voice failed"; };
    window.speechSynthesis.speak(utterance);
}


// =============================================================================
// ─── PROFILE SYSTEM ──────────────────────────────────────────────────────────
// =============================================================================

let userProfile = null;

function initProfile() {
    const saved = localStorage.getItem("mutex_profile");
    if (saved) {
        try {
            userProfile = JSON.parse(saved);
            applyProfile(userProfile);
            hideOnboarding();
            return;
        } catch (_) {
            localStorage.removeItem("mutex_profile");
        }
    }
}

function hideOnboarding() {
    const overlay = document.getElementById("onboarding-overlay");
    if (overlay) overlay.style.display = "none";
}

async function confirmProfile() {
    const selected = document.querySelector(".profile-option.selected");
    if (!selected) return;
    const disability = selected.dataset.disability;
    const confirmBtn = document.getElementById("onboarding-confirm");
    confirmBtn.textContent = "Loading...";
    confirmBtn.disabled = true;
    try {
        const res     = await fetch(`${API_URL}/profile?disability=${disability}`);
        const profile = await res.json();
        applyProfile(profile);
        hideOnboarding();
    } catch (err) {
        console.error("Profile fetch failed:", err);
        confirmBtn.textContent = "Continue";
        confirmBtn.disabled    = false;
    }
}

function applyProfile(profile) {
    userProfile = profile;
    window.userProfile = profile;   // expose to sign_language.js (let vars don't attach to window)
    localStorage.setItem("mutex_profile", JSON.stringify(profile));

    const nameEl = document.getElementById("profile-name");
    if (nameEl) {
        const labels = {
            visual:    "Visual",
            motor:     "Motor / Voice",
            cognitive: "Adaptive",
            hearing:   "Deaf / HoH",
            multi:     "Multi",
        };
        nameEl.textContent = labels[profile.disability] || profile.disability;
    }

    const panel = document.getElementById("voice-panel");
    if (panel) panel.hidden = !profile.voice_input;

    document.body.classList.toggle("high-contrast", !!profile.high_contrast);
    document.body.classList.toggle("simplified",    !!profile.simplified_ui);

    // Activate Sign Language Mode if profile is hearing or multi
    if (window.slInit) window.slInit();
}

function resetProfile() {
    localStorage.removeItem("mutex_profile");
    userProfile = null;
    location.reload();
}

document.querySelectorAll(".profile-option").forEach(card => {
    const activate = () => {
        document.querySelectorAll(".profile-option").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        const btn = document.getElementById("onboarding-confirm");
        btn.disabled = false;
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
});


// =============================================================================
// ─── AUDIO QUEUE  (sentence-level playback) ──────────────────────────────────
// =============================================================================

let audioQueue  = [];   // array of base64 MP3 strings
let audioPlaying = false;

/**
 * Add a base64 MP3 chunk to the queue.
 * Playback starts immediately if nothing is currently playing.
 */
function enqueueAudio(b64) {
    audioQueue.push(b64);
    if (!audioPlaying) drainAudioQueue();
}

function drainAudioQueue() {
    if (audioQueue.length === 0) {
        audioPlaying = false;
        // Resume always-on listening once audio finishes
        if (alwaysOnMode && !isProcessingVoice && !isListening) {
            setTimeout(startListening, 500);
        }
        return;
    }
    audioPlaying = true;
    const b64    = audioQueue.shift();
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob  = new Blob([bytes], { type: "audio/mpeg" });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playbackRate = userProfile?.tts_speed || 1.0;
    audio.onended = () => { URL.revokeObjectURL(url); drainAudioQueue(); };
    audio.onerror = () => { URL.revokeObjectURL(url); drainAudioQueue(); };
    audio.play().catch(err => {
        console.warn("Audio play failed (autoplay policy?):", err);
        audioPlaying = false;
        fallbackTTS(document.getElementById("voice-answer")?.textContent || "");
    });
}

function clearAudioQueue() {
    audioQueue  = [];
    audioPlaying = false;
}

function fallbackTTS(text) {
    if (!window.speechSynthesis || !text) return;
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate  = userProfile?.tts_speed || 1.0;
    // Block always-on from restarting the mic while the computer is speaking
    audioPlaying = true;
    utt.onend = utt.onerror = () => {
        audioPlaying = false;
        if (alwaysOnMode && !isProcessingVoice && !isListening) {
            setTimeout(startListening, 500);
        }
    };
    speechSynthesis.speak(utt);
}


// =============================================================================
// ─── VOICE STUDY MODE ────────────────────────────────────────────────────────
// =============================================================================

const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition      = null;
let isListening      = false;
let isProcessingVoice = false;
let alwaysOnMode     = false;
let conversationContext = [];   // max 8 entries = 4 turns (RULE 5)

function initRecognition() {
    if (!SpeechRecognition) {
        console.warn("SpeechRecognition not supported");
        const btn = document.getElementById("voice-record-btn");
        if (btn) { btn.textContent = "Voice not supported — use Chrome or Edge"; btn.disabled = true; }
        const tog = document.getElementById("always-on-btn");
        if (tog) { tog.disabled = true; }
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang             = "en-US";
    recognition.interimResults   = false;   // RULE 7 — fire once on final result
    recognition.maxAlternatives  = 1;       // RULE 7 — fastest path
    recognition.continuous       = false;   // we restart manually after each turn

    recognition.onstart = () => {
        isListening = true;
        setVoiceStatus("Listening...");
        document.getElementById("voice-record-btn")?.classList.add("recording");
    };

    // RULE 7 — dispatch API call the instant the transcript arrives
    recognition.onresult = event => {
        const transcript = event.results[0][0].transcript.trim();
        if (!transcript) return;

        const tEl = document.getElementById("voice-transcript");
        if (tEl) tEl.textContent = "You: " + transcript;

        setVoiceStatus("Thinking...");
        clearAudioQueue();  // discard any queued audio from previous turn

        // Capture current board frame alongside the question
        const imageB64 = captureFrameBase64();
        sendVoiceQueryStream(transcript, imageB64);
    };

    recognition.onerror = event => {
        console.error("SpeechRecognition error:", event.error);
        if (event.error === "no-speech" && alwaysOnMode) {
            // silence timeout in always-on mode — just restart silently
            return;
        }
        setVoiceStatus(
            event.error === "not-allowed"
                ? "Microphone denied — check browser settings"
                : "Could not hear clearly — try again"
        );
        resetVoiceButton();
    };

    recognition.onend = () => {
        isListening = false;
        resetVoiceButton();
        // Always-on: restart listening after a brief gap, but not while audio is playing
        if (alwaysOnMode && !isProcessingVoice && !audioPlaying) {
            setTimeout(startListening, 400);
        }
    };
}

function startListening() {
    if (!recognition || isListening || isProcessingVoice || audioPlaying) return;
    try { recognition.start(); } catch (_) { /* already started */ }
}

function stopListening() {
    if (!recognition || !isListening) return;
    recognition.stop();
}

// ─── Always-On toggle ────────────────────────────────────────────────────────

function toggleAlwaysOn() {
    alwaysOnMode = !alwaysOnMode;

    const btn = document.getElementById("always-on-btn");
    if (btn) {
        btn.textContent = alwaysOnMode ? "🔴 Always On — tap to stop" : "🎙 Always On";
        btn.classList.toggle("always-on-active", alwaysOnMode);
        btn.setAttribute("aria-pressed", String(alwaysOnMode));
    }

    const recordBtn = document.getElementById("voice-record-btn");
    if (recordBtn) recordBtn.hidden = alwaysOnMode;

    if (alwaysOnMode) {
        setVoiceStatus("Always listening — speak any time");
        startListening();
    } else {
        stopListening();
        setVoiceStatus("Ready — press and hold to speak");
    }
}

// ─── Streaming voice query (SSE) ─────────────────────────────────────────────

let streamReceivedAudio = false;   // tracks whether Polly sent any audio this turn

async function sendVoiceQueryStream(transcript, imageB64) {
    if (!userProfile) return;
    isProcessingVoice   = true;
    streamReceivedAudio = false;

    try {
        const res = await fetch(`${API_URL}/voice/stream`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                transcript,
                profile:   userProfile,
                context:   conversationContext.slice(-4),   // RULE 5
                image_b64: imageB64 || null,
                board_context: {
                    last_latex:       lastLatex       || "",
                    last_explanation: lastExplanation || "",
                    last_confidence:  lastConfidence  || "",
                    recommendations:  lastRecommendations,
                },
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();   // keep incomplete line for next chunk

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    handleStreamEvent(data, transcript);
                } catch (_) { /* malformed line — skip */ }
            }
        }
    } catch (err) {
        console.error("Voice stream failed:", err);
        setVoiceStatus("Error — please try again");
    } finally {
        isProcessingVoice = false;
        // If always-on and audio is already done, restart listening
        if (alwaysOnMode && !audioPlaying && !isListening) {
            setTimeout(startListening, 500);
        }
    }
}

function handleStreamEvent(data, originalTranscript) {
    if (data.type === "answer") {
        // Update text UI immediately — audio will start via "audio" events below
        const answerEl  = document.getElementById("voice-answer");
        const subjectEl = document.getElementById("voice-subject");
        if (answerEl)  answerEl.textContent  = data.text;
        if (subjectEl && data.subject && data.subject !== "unknown")
            subjectEl.textContent = "Topic: " + data.subject;
        setVoiceStatus(
            data.confidence === "low"
                ? "Low confidence — could you rephrase?"
                : alwaysOnMode ? "Always listening — speak any time" : "Speaking..."
        );

    } else if (data.type === "audio") {
        // RULE 6 — enqueue audio; first chunk plays immediately, rest queue up
        if (userProfile?.voice_output && !userProfile?.captions_only) {
            streamReceivedAudio = true;
            enqueueAudio(data.b64);
        }

    } else if (data.type === "done") {
        // If Polly was unavailable (no audio events), fall back to Web Speech API
        if (!streamReceivedAudio && userProfile?.voice_output && !userProfile?.captions_only) {
            const answerText = document.getElementById("voice-answer")?.textContent || "";
            if (answerText) fallbackTTS(answerText);
        }

        // Render follow-up suggestion chips
        // follow_up items may be plain strings OR {text, latex} objects
        const fuEl = document.getElementById("follow-ups");
        if (fuEl && data.follow_up?.length > 0) {
            fuEl.innerHTML = "";
            const mathEls = [];
            data.follow_up.forEach((q, idx) => {
                const text  = typeof q === "object" ? (q.text  || "") : q;
                const latex = typeof q === "object" ? (q.latex || "") : "";

                const btn = document.createElement("button");
                btn.className = "follow-up-btn";
                btn.setAttribute("aria-label", "Ask: " + text);

                if (latex) {
                    const mathEl = document.createElement("div");
                    mathEl.className   = "fu-latex";
                    mathEl.textContent = `\\(\\displaystyle ${latex}\\)`;
                    btn.appendChild(mathEl);
                    mathEls.push(mathEl);
                }

                const labelEl = document.createElement("div");
                labelEl.className   = "fu-text";
                labelEl.textContent = `${idx + 1}. ${text}`;
                btn.appendChild(labelEl);

                btn.onclick = () => {
                    document.getElementById("voice-transcript").textContent = "You: " + text;
                    setVoiceStatus("Thinking...");
                    fuEl.innerHTML = "";
                    clearAudioQueue();
                    sendVoiceQueryStream(text, captureFrameBase64());
                };
                fuEl.appendChild(btn);
            });

            // Render all LaTeX in one pass
            if (mathEls.length > 0 && window.MathJax) {
                MathJax.typesetPromise(mathEls).catch(e => console.warn("MathJax fu render:", e));
            }
        }

        // Mirror follow-up chips into the rec-chips section to keep drill loop running
        if (data.follow_up?.length > 0) {
            lastRecommendations = data.follow_up.map(q =>
                typeof q === "object" ? q : { text: q, latex: "" }
            );
            const recChips   = document.getElementById("rec-chips");
            const recSection = document.getElementById("rec-section");
            if (recChips && recSection) {
                recSection.hidden = false;
                recChips.hidden   = false;
                renderRecChips(lastRecommendations, recChips);
            }
        }

        // Update conversation context — cap at 8 items = 4 turns (RULE 5)
        const answerText = document.getElementById("voice-answer")?.textContent || "";
        conversationContext.push(
            { role: "user",      content: originalTranscript },
            { role: "assistant", content: answerText }
        );
        if (conversationContext.length > 8) conversationContext = conversationContext.slice(-8);

    } else if (data.type === "error") {
        setVoiceStatus("Error: " + data.message);
    }
}

// ─── Voice button helpers ─────────────────────────────────────────────────────

function setVoiceStatus(msg) {
    const el = document.getElementById("voice-status");
    if (el) el.textContent = msg;
}

function resetVoiceButton() {
    document.getElementById("voice-record-btn")?.classList.remove("recording");
}


// =============================================================================
// ─── BOOT ────────────────────────────────────────────────────────────────────
// =============================================================================
// Script is at bottom of <body> — DOM is ready, no DOMContentLoaded needed.

initProfile();
initRecognition();
// slInit() is also called inside applyProfile() whenever a profile is set/loaded.
// The call below handles the case where slInit runs before sign_language.js loads,
// so we defer it slightly to ensure sign_language.js has executed first.
setTimeout(() => { if (window.slInit) window.slInit(); }, 0);

// Hold-to-speak (push-to-talk) on the record button
const voiceRecordBtn = document.getElementById("voice-record-btn");
if (voiceRecordBtn) {
    voiceRecordBtn.addEventListener("mousedown",  startListening);
    voiceRecordBtn.addEventListener("mouseup",    stopListening);
    voiceRecordBtn.addEventListener("mouseleave", stopListening);
    voiceRecordBtn.addEventListener("touchstart", e => {
        e.preventDefault(); startListening();
    }, { passive: false });
    voiceRecordBtn.addEventListener("touchend", stopListening);
}


// =============================================================================
// ─── PRACTICE RECOMMENDATIONS ────────────────────────────────────────────────
// =============================================================================
// Triggered after /analyze returns. Non-blocking — never delays LaTeX rendering.

let lastRecommendations = [];   // only new global — [{ text, latex }]

async function fetchRecommendations(latex, explanation) {
    if (!latex || !userProfile) return;

    const section = document.getElementById("rec-section");
    const loading = document.getElementById("rec-loading");
    const chips   = document.getElementById("rec-chips");
    if (!section || !chips) return;

    // Show loading skeleton immediately; chips area cleared and hidden until ready
    section.hidden = false;
    if (loading) loading.hidden = false;
    chips.innerHTML = "";
    chips.hidden    = true;

    try {
        const res = await fetch(`${API_URL}/recommend`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ latex, explanation, profile: userProfile }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const recs = (data.recommendations || []).filter(r => r.text);

        if (loading) loading.hidden = true;

        if (recs.length === 0) {
            section.hidden = true;
            return;
        }

        lastRecommendations = recs;
        chips.hidden = false;
        renderRecChips(recs, chips);

    } catch (err) {
        console.warn("/recommend failed (non-critical):", err);
        if (section) section.hidden = true;
    }
}

function renderRecChips(recs, container) {
    container.innerHTML = "";
    const mathEls = [];

    recs.forEach((item, idx) => {
        const chip = document.createElement("div");
        chip.className = "rec-chip";
        chip.setAttribute("role",       "button");
        chip.setAttribute("tabindex",   "0");
        chip.setAttribute("aria-label", `Practice problem ${idx + 1}: ${item.text}`);

        if (item.latex) {
            const mathEl = document.createElement("div");
            mathEl.className   = "rec-latex";
            // displaystyle forces full-size fraction/integral rendering
            mathEl.textContent = `\\(\\displaystyle ${item.latex}\\)`;
            chip.appendChild(mathEl);
            mathEls.push(mathEl);
        }

        const textEl = document.createElement("div");
        textEl.className   = "rec-text";
        textEl.textContent = `${idx + 1}. ${item.text}`;
        chip.appendChild(textEl);

        const hintEl = document.createElement("div");
        hintEl.className   = "rec-hint";
        hintEl.textContent = "Tap for step-by-step solution →";
        chip.appendChild(hintEl);

        const activate = () => selectRecChip(chip, item);
        chip.addEventListener("click",   activate);
        chip.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
        });

        container.appendChild(chip);
    });

    // Render all LaTeX in one pass after all chips are in the DOM (constraint #6)
    if (mathEls.length > 0 && window.MathJax) {
        MathJax.typesetPromise(mathEls).catch(e => console.warn("MathJax rec render:", e));
    }
}

function selectRecChip(chipEl, item) {
    // Visual selection state
    document.querySelectorAll(".rec-chip")
        .forEach(c => c.classList.remove("rec-selected"));
    chipEl.classList.add("rec-selected");

    // Update status + transcript so the student sees what was activated
    setVoiceStatus("Solving…");
    const transcriptEl = document.getElementById("voice-transcript");
    if (transcriptEl) transcriptEl.textContent = "You: " + item.text;

    // Fire both in parallel — voice answer + visual step-by-step (non-blocking)
    sendVoiceQueryStream(item.text, captureFrameBase64());
    fetchSolution(item);   // fire-and-forget
}

// ── Step-by-step solution panel ───────────────────────────────────────────────

async function fetchSolution(item) {
    if (!userProfile) return;

    const panel   = document.getElementById("solution-panel");
    const loading = document.getElementById("solution-loading");
    const body    = document.getElementById("solution-body");
    if (!panel) return;

    // Show loading immediately
    panel.hidden   = false;
    if (loading) loading.hidden = false;
    if (body)    body.hidden    = true;

    try {
        const res = await fetch(`${API_URL}/solve`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                latex:   item.latex || "",
                text:    item.text  || "",
                profile: userProfile,
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (loading) loading.hidden = true;

        if (!data.steps || data.steps.length === 0) {
            panel.hidden = true;
            return;
        }

        renderSolutionPanel(item, data);

    } catch (err) {
        console.warn("/solve failed (non-critical):", err);
        if (panel)   panel.hidden   = true;
        if (loading) loading.hidden = true;
    }
}

function renderSolutionPanel(item, data) {
    const body        = document.getElementById("solution-body");
    const stepsEl     = document.getElementById("solution-steps");
    const probLatexEl = document.getElementById("solution-problem-latex");
    const probTextEl  = document.getElementById("solution-problem-text");
    const answerEl    = document.getElementById("solution-answer");
    const ansLatexEl  = document.getElementById("solution-answer-latex");
    if (!body || !stepsEl) return;

    const mathEls = [];

    // Problem header
    if (probLatexEl) {
        if (item.latex) {
            probLatexEl.textContent = `\\(\\displaystyle ${item.latex}\\)`;
            mathEls.push(probLatexEl);
        } else {
            probLatexEl.textContent = "";
        }
    }
    if (probTextEl) probTextEl.textContent = item.text || "";

    // Build step cards
    stepsEl.innerHTML = "";
    data.steps.forEach(step => {
        const li = document.createElement("li");
        li.className = "solution-step";

        const descEl = document.createElement("div");
        descEl.className   = "step-description";
        descEl.textContent = step.description || "";
        li.appendChild(descEl);

        if (step.latex) {
            const stepMath = document.createElement("div");
            stepMath.className   = "step-latex";
            stepMath.textContent = `\\[${step.latex}\\]`;
            li.appendChild(stepMath);
            mathEls.push(stepMath);
        }

        stepsEl.appendChild(li);
    });

    // Final answer
    if (answerEl && ansLatexEl) {
        if (data.final_latex) {
            ansLatexEl.textContent = `\\(\\displaystyle ${data.final_latex}\\)`;
            mathEls.push(ansLatexEl);
            answerEl.hidden = false;
        } else {
            answerEl.hidden = true;
        }
    }

    body.hidden = false;

    // Render all LaTeX in one pass, then scroll the panel into view
    const afterRender = mathEls.length > 0 && window.MathJax
        ? MathJax.typesetPromise(mathEls).catch(e => console.warn("MathJax solve render:", e))
        : Promise.resolve();

    afterRender.then(() => {
        const panel = document.getElementById("solution-panel");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
}

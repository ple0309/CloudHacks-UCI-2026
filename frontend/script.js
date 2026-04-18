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
        const fuEl = document.getElementById("follow-ups");
        if (fuEl && data.follow_up?.length > 0) {
            fuEl.innerHTML = "";
            data.follow_up.forEach(q => {
                const btn = document.createElement("button");
                btn.textContent = q;
                btn.className   = "follow-up-btn";
                btn.setAttribute("aria-label", "Ask: " + q);
                btn.onclick = () => {
                    document.getElementById("voice-transcript").textContent = "You: " + q;
                    setVoiceStatus("Thinking...");
                    fuEl.innerHTML = "";
                    clearAudioQueue();
                    sendVoiceQueryStream(q, captureFrameBase64());
                };
                fuEl.appendChild(btn);
            });
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

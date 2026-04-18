const API_URL =
    document.querySelector('meta[name="api-url"]')?.content ||
    'http://127.0.0.1:5000';

let stream = null;
let intervalId = null;
let isAnalyzing = false;

let lastLatex = "";
let lastExplanation = "No explanation available yet.";
let lastConfidence = "";

// Elements
const camera = document.getElementById("camera");
const snapshot = document.getElementById("snapshot");
const statusEl = document.getElementById("status");
const latexEl = document.getElementById("latexOutput");
const explanationEl = document.getElementById("explanationOutput");
const confidenceEl = document.getElementById("confidenceOutput");
const renderedEl = document.getElementById("renderedOutput");
const statusBadge = document.getElementById("statusBadge");
const warningBanner = document.getElementById("warningBanner");
const ariaLive = document.getElementById("ariaLive");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const voiceBtn = document.getElementById("voiceBtn");

startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click", stopCamera);
voiceBtn.addEventListener("click", speakResult);

// --- Helpers ---

function clearConfidenceClasses(el) {
    el.classList.remove("conf-low", "conf-medium", "conf-high");
}

function applyConfidenceClass(el, confidence) {
    clearConfidenceClasses(el);
    if (confidence === "low") el.classList.add("conf-low");
    else if (confidence === "medium") el.classList.add("conf-medium");
    else if (confidence === "high") el.classList.add("conf-high");
}

function showWarning(message) {
    warningBanner.textContent = message;
    warningBanner.hidden = false;
}

function hideWarning() {
    warningBanner.hidden = true;
    warningBanner.textContent = "";
}

function announceToScreenReader(text) {
    if (ariaLive) ariaLive.textContent = text;
}

// --- Camera ---

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

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }

    camera.srcObject = null;
    statusEl.textContent = "Status: camera stopped";
    statusBadge.textContent = "stopped";
    clearConfidenceClasses(statusBadge);
    hideWarning();
}

// --- Capture loop ---

function startAutoCapture() {
    stopAutoCapture();
    intervalId = setInterval(() => {
        if (!isAnalyzing && stream) captureAndAnalyzeFrame();
    }, 2000);
}

function stopAutoCapture() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

function captureCurrentFrameBlob() {
    return new Promise((resolve) => {
        const ctx = snapshot.getContext("2d");
        snapshot.width = camera.videoWidth || 640;
        snapshot.height = camera.videoHeight || 480;
        ctx.drawImage(camera, 0, 0, snapshot.width, snapshot.height);
        snapshot.toBlob((blob) => resolve(blob), "image/png");
    });
}

// --- Analyze ---

async function captureAndAnalyzeFrame() {
    if (!stream) return;

    isAnalyzing = true;
    statusEl.textContent = "Status: analyzing frame...";

    try {
        const blob = await captureCurrentFrameBlob();

        const formData = new FormData();
        formData.append("image", blob, "frame.png");

        const res = await fetch(`${API_URL}/analyze`, {
            method: "POST",
            body: formData,
        });

        if (!res.ok) {
            throw new Error(`Server error: ${res.status}`);
        }

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
            latexEl.textContent = data.latex || "";
            explanationEl.textContent = data.explanation || "";
            confidenceEl.textContent = data.confidence || "";

            lastLatex = data.latex || "";
            lastExplanation = data.explanation || lastExplanation;
            lastConfidence = data.confidence || "";

            applyConfidenceClass(confidenceEl, data.confidence);
            statusBadge.textContent = data.confidence;
            applyConfidenceClass(statusBadge, data.confidence);

            renderedEl.innerHTML = data.latex ? `$$${data.latex}$$` : "Waiting...";
            if (window.MathJax) {
                MathJax.typesetPromise([renderedEl]).catch((err) => console.error(err));
            }

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

// --- Voice ---

function speakResult() {
    const text = lastExplanation && lastExplanation.trim()
        ? lastExplanation
        : "No explanation available.";

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) utterance.voice = voices[0];

    utterance.onstart = () => { statusEl.textContent = "Status: reading aloud"; };
    utterance.onend = () => { statusEl.textContent = "Status: voice finished"; };
    utterance.onerror = (err) => {
        console.error("Speech error:", err);
        statusEl.textContent = "Status: voice failed";
    };

    window.speechSynthesis.speak(utterance);
}

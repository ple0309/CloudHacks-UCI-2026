let stream = null;
let intervalId = null;
let isAnalyzing = false;

// Store last results
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

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const voiceBtn = document.getElementById("voiceBtn");

// Button events
startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click", stopCamera);
voiceBtn.addEventListener("click", speakResult);

// Helpers
function clearConfidenceClasses(el) {
    el.classList.remove("conf-low", "conf-medium", "conf-high");
}

function applyConfidenceClass(el, confidence) {
    clearConfidenceClasses(el);

    if (confidence === "low") {
        el.classList.add("conf-low");
    } else if (confidence === "medium") {
        el.classList.add("conf-medium");
    } else if (confidence === "high") {
        el.classList.add("conf-high");
    }
}

// Start camera
async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
        camera.srcObject = stream;

        statusEl.textContent = "Status: camera started";
        statusBadge.textContent = "live";
        clearConfidenceClasses(statusBadge);

        startAutoCapture();
    } catch (err) {
        console.error(err);
        statusEl.textContent = "Status: failed to access camera";
        statusBadge.textContent = "error";
        clearConfidenceClasses(statusBadge);
    }
}

// Stop camera
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
}

// Start auto capture loop
function startAutoCapture() {
    stopAutoCapture();

    intervalId = setInterval(() => {
        if (!isAnalyzing && stream) {
            captureAndAnalyzeFrame();
        }
    }, 2000);
}

// Stop loop
function stopAutoCapture() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

// Capture frame
function captureCurrentFrameBlob() {
    return new Promise((resolve) => {
        const ctx = snapshot.getContext("2d");

        snapshot.width = camera.videoWidth || 640;
        snapshot.height = camera.videoHeight || 480;

        ctx.drawImage(camera, 0, 0, snapshot.width, snapshot.height);

        snapshot.toBlob((blob) => {
            resolve(blob);
        }, "image/png");
    });
}

// Main analyze loop
async function captureAndAnalyzeFrame() {
    if (!stream) return;

    isAnalyzing = true;
    statusEl.textContent = "Status: analyzing frame...";

    try {
        const blob = await captureCurrentFrameBlob();

        const formData = new FormData();
        formData.append("image", blob, "frame.png");

        const res = await fetch("http://127.0.0.1:5000/analyze", {
            method: "POST",
            body: formData
        });

        const data = await res.json();

        // Low confidence: keep old result, only update status/badge/confidence
        if (!data.confidence || data.confidence === "low") {
            statusEl.textContent = "Status: low confidence, move closer";
            statusBadge.textContent = "low";
            confidenceEl.textContent = data.confidence || "low";

            applyConfidenceClass(statusBadge, "low");
            applyConfidenceClass(confidenceEl, "low");
            return;
        }

        // Only update if new result
        if (data.latex !== lastLatex) {
            latexEl.textContent = data.latex || "";
            explanationEl.textContent = data.explanation || "";
            confidenceEl.textContent = data.confidence || "";

            // Save state
            lastLatex = data.latex || "";
            lastExplanation = data.explanation || lastExplanation;
            lastConfidence = data.confidence || "";

            // Apply colors
            applyConfidenceClass(confidenceEl, data.confidence);
            statusBadge.textContent = data.confidence;
            applyConfidenceClass(statusBadge, data.confidence);

            // Render LaTeX
            renderedEl.innerHTML = data.latex ? `$$${data.latex}$$` : "Waiting...";
            if (window.MathJax) {
                MathJax.typesetPromise([renderedEl]).catch((err) => console.error(err));
            }

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
    } finally {
        isAnalyzing = false;
    }
}

// Voice output
function speakResult() {
    const text = lastExplanation && lastExplanation.trim()
        ? lastExplanation
        : "No explanation available.";

    console.log("Speaking:", text);

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
        utterance.voice = voices[0];
    }

    utterance.onstart = () => {
        statusEl.textContent = "Status: reading aloud";
    };

    utterance.onend = () => {
        statusEl.textContent = "Status: voice finished";
    };

    utterance.onerror = (err) => {
        console.error("Speech error:", err);
        statusEl.textContent = "Status: voice failed";
    };

    window.speechSynthesis.speak(utterance);
}
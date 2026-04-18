import os
import re
import json
import logging
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS

load_dotenv()

from bedrock_model import BedrockModel
from voice_model import VoiceModel
from profile import ProfileManager
from formatter import format_response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)

model = BedrockModel()


# ─── Utility ──────────────────────────────────────────────────────────────────

def _split_sentences(text: str) -> list:
    """Split answer into sentences for sentence-level Polly streaming."""
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    return [p.strip() for p in parts if p.strip()]


# ─── Static / health ─────────────────────────────────────────────────────────

@app.route("/")
def serve_index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok", "model": "bedrock"})


# ─── Profile ──────────────────────────────────────────────────────────────────

@app.route("/profile", methods=["GET"])
def get_profile():
    disability = request.args.get("disability", "visual")
    try:
        pm = ProfileManager()
        return jsonify(pm.get_preset(disability))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/profile", methods=["POST"])
def post_profile():
    body = request.get_json(force=True, silent=True) or {}
    disability = body.get("disability")
    if not disability:
        return jsonify({"error": "disability field required"}), 400
    try:
        pm = ProfileManager()
        profile = pm.get_preset(disability)
        overrides = body.get("overrides", {})
        if overrides:
            profile = pm.apply_overrides(profile, overrides)
        return jsonify(profile)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


# ─── Analyze (webcam frame → LaTeX) ──────────────────────────────────────────

@app.route("/analyze", methods=["GET", "POST"])
def analyze():
    if request.method == "GET":
        return "Analyze endpoint works. Send POST with an image."

    image = request.files.get("image")
    if not image:
        return jsonify({"error": "No image uploaded"}), 400

    profile_raw = request.form.get("profile")
    pm = ProfileManager()
    if profile_raw:
        try:
            profile = json.loads(profile_raw)
        except Exception:
            profile = pm.get_preset("visual")
    else:
        profile = pm.get_preset("visual")

    tmp_path = f"/tmp/{uuid4()}.png"
    try:
        image.save(tmp_path)
        raw = model.process_image(tmp_path, profile)
        return jsonify(format_response(raw))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# ─── Voice — single-shot (kept for compatibility) ────────────────────────────

@app.route("/voice", methods=["POST"])
def voice():
    """
    Non-streaming voice endpoint.
    Prefer /voice/stream for real-time demos — this is kept for fallback.
    """
    body = request.get_json(force=True, silent=True) or {}

    transcript = body.get("transcript", "").strip()
    if not transcript:
        return jsonify({"error": "transcript field required"}), 400

    pm = ProfileManager()
    raw_profile = body.get("profile")
    profile = raw_profile if isinstance(raw_profile, dict) else pm.get_preset("motor")

    if not profile.get("voice_input", False):
        return jsonify({"error": "Voice input not enabled for this profile"}), 403

    context = body.get("context", [])[-4:]
    image_b64 = body.get("image_b64")

    try:
        vm = VoiceModel()
        answer_dict = vm.answer_question(transcript, profile, context, image_b64)

        audio_b64 = None
        if profile.get("voice_output") and not profile.get("captions_only"):
            audio_b64 = vm.synthesize_speech(answer_dict["answer"], profile)

        return jsonify({
            "transcript": transcript,
            "answer": answer_dict["answer"],
            "subject": answer_dict["subject"],
            "follow_up": answer_dict["follow_up"],
            "confidence": answer_dict["confidence"],
            "audio_b64": audio_b64,
        })
    except Exception as exc:
        logger.error("/voice error: %s", exc, exc_info=True)
        return jsonify({"error": str(exc)}), 500


# ─── Voice Stream — sentence-level Polly streaming via SSE ───────────────────

@app.route("/voice/stream", methods=["POST"])
def voice_stream():
    """
    Streaming voice endpoint using Server-Sent Events.

    Flow:
      1. Bedrock answer generated (non-streaming, max_tokens=350)
      2. Answer split into sentences
      3. Each sentence synthesized by Polly and streamed immediately
         → first audio chunk arrives at browser ~400ms after Bedrock responds
         → subsequent sentences play back-to-back without gaps

    SSE event types:
      { type: "answer",  text, subject, confidence }   — sent first, updates UI
      { type: "audio",   b64 }                          — one per sentence
      { type: "done",    follow_up }                    — final event
      { type: "error",   message }                      — on failure
    """
    body = request.get_json(force=True, silent=True) or {}

    transcript = body.get("transcript", "").strip()
    if not transcript:
        return jsonify({"error": "transcript field required"}), 400

    pm = ProfileManager()
    raw_profile = body.get("profile")
    profile = raw_profile if isinstance(raw_profile, dict) else pm.get_preset("motor")

    if not profile.get("voice_input", False):
        return jsonify({"error": "Voice input not enabled for this profile"}), 403

    context = body.get("context", [])[-4:]
    image_b64 = body.get("image_b64")   # current board frame, may be None

    def generate():
        try:
            vm = VoiceModel()

            # Step 1 — get Bedrock answer (includes board image if provided)
            answer_dict = vm.answer_question(transcript, profile, context, image_b64)

            # Step 2 — stream answer text first so UI updates immediately
            yield (
                "data: "
                + json.dumps({
                    "type": "answer",
                    "text": answer_dict["answer"],
                    "subject": answer_dict["subject"],
                    "confidence": answer_dict["confidence"],
                })
                + "\n\n"
            )

            # Step 3 — sentence-level Polly synthesis and streaming
            # First sentence audio arrives ~400ms after Bedrock responds
            # Subsequent sentences synthesize while first is already playing
            if profile.get("voice_output") and not profile.get("captions_only"):
                sentences = _split_sentences(answer_dict["answer"])
                for sentence in sentences:
                    audio_b64_chunk = vm.synthesize_speech(sentence, profile)
                    if audio_b64_chunk:
                        yield (
                            "data: "
                            + json.dumps({"type": "audio", "b64": audio_b64_chunk})
                            + "\n\n"
                        )

            # Step 4 — final event with follow-up suggestions
            yield (
                "data: "
                + json.dumps({"type": "done", "follow_up": answer_dict["follow_up"]})
                + "\n\n"
            )

        except Exception as exc:
            logger.error("/voice/stream error: %s", exc, exc_info=True)
            yield (
                "data: "
                + json.dumps({"type": "error", "message": str(exc)})
                + "\n\n"
            )

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",      # disable nginx buffering if behind proxy
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    # threaded=True is required for SSE — each request needs its own thread
    app.run(debug=True, threaded=True)

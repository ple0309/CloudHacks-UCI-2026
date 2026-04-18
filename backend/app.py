import os
import json
import logging
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

load_dotenv()

from bedrock_model import BedrockModel
from voice_model import VoiceModel
from profile import ProfileManager
from formatter import format_response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Flask serves the frontend folder as static files — same origin, no CORS issues.
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)

model = BedrockModel()


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
        profile = pm.get_preset(disability)
        return jsonify(profile)
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

    # Parse profile from form field (multipart sends it as a string)
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
        result = format_response(raw)
        return jsonify(result)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# ─── Voice (transcript → Bedrock answer → Polly audio) ───────────────────────

@app.route("/voice", methods=["POST"])
def voice():
    """
    Option A architecture: browser SpeechRecognition handles STT.
    This endpoint receives plain text and returns JSON + base64 MP3.

    Body:  { transcript, profile, context }
    Returns: { transcript, answer, subject, follow_up, confidence, audio_b64 }
    """
    body = request.get_json(force=True, silent=True) or {}

    transcript = body.get("transcript", "").strip()
    if not transcript:
        return jsonify({"error": "transcript field required"}), 400

    raw_profile = body.get("profile")
    pm = ProfileManager()
    if raw_profile and isinstance(raw_profile, dict):
        profile = raw_profile
    else:
        profile = pm.get_preset("motor")

    # Guard — only allow voice-input-enabled profiles
    if not profile.get("voice_input", False):
        return jsonify({"error": "Voice input not enabled for this profile"}), 403

    # RULE 5 — cap context at 4 turns
    context = body.get("context", [])[-4:]

    try:
        vm = VoiceModel()

        # Step 1 — Bedrock answer (RULE 1: max_tokens=350 inside VoiceModel)
        answer_dict = vm.answer_question(transcript, profile, context)

        # Step 2 — Polly synthesis immediately after Bedrock (RULE 3 — no delay)
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


if __name__ == "__main__":
    app.run(debug=True)

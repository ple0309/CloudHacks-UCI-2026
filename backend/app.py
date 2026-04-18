import os
import logging
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

load_dotenv()

from bedrock_model import BedrockModel
from formatter import format_response

logging.basicConfig(level=logging.INFO)

app = Flask(__name__)
CORS(app)

model = BedrockModel()


@app.route("/")
def home():
    return "MuTeX backend is running"


@app.route("/health")
def health():
    return jsonify({"status": "ok", "model": "bedrock"})


@app.route("/analyze", methods=["GET", "POST"])
def analyze():
    if request.method == "GET":
        return "Analyze endpoint works. Send POST with an image."

    image = request.files.get("image")
    if not image:
        return jsonify({"error": "No image uploaded"}), 400

    tmp_path = f"/tmp/{uuid4()}.png"
    try:
        image.save(tmp_path)
        raw = model.process_image(tmp_path)
        result = format_response(raw)
        return jsonify(result)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


if __name__ == "__main__":
    app.run(debug=True)

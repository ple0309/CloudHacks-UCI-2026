from flask import Flask, request, jsonify
from flask_cors import CORS
from mock_model import MockModel
from formatter import format_response

app = Flask(__name__)
CORS(app)

# Swap this later:
# from bedrock_model import BedrockModel
# model = BedrockModel()
model = MockModel()

@app.route("/")
def home():
    return "MuTeX backend is running"

@app.route("/analyze", methods=["GET", "POST"])
def analyze():
    if request.method == "GET":
        return "Analyze endpoint works. Send POST with an image."

    image = request.files.get("image")
    if not image:
        return jsonify({"error": "No image uploaded"}), 400

    path = "temp.png"
    image.save(path)

    raw = model.process_image(path)
    result = format_response(raw)
    return jsonify(result)

if __name__ == "__main__":
    app.run(debug=True)
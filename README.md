# MuTeX — Accessible Math Transcription

> **CloudHacks UCI 2026 Hackathon Project**

MuTeX is a live demo tool that helps **students with disabilities** access STEM content. A student holds up a handwritten or printed math problem to their webcam. Every 2 seconds a frame is captured, sent to AWS Bedrock (Claude Sonnet 4.6), and the result is:

- **Rendered visually** as LaTeX via MathJax
- **Explained in plain English** for students who need conceptual guidance
- **Read aloud** via the browser's Web Speech API — no headphones required
- **Confidence-rated** so students know when to reposition the camera
- **Screen-reader friendly** — aria-live regions announce results automatically

---

## AWS Services Used

| Service | Role |
|---|---|
| **Amazon Bedrock (Claude Sonnet 4.6)** | Vision + LaTeX transcription + explanation generation |
| **Amazon S3** | *(Optional)* Temporary frame archive — auto-deleted after processing. Requires separate IAM credentials. |
| **Amazon Polly** | *(Roadmap)* Higher-quality TTS to replace Web Speech API |

---

## Architecture

```
Browser (Vanilla JS + MathJax)
        |
        |  POST /analyze  (multipart/form-data, every 2 s)
        v
  Flask Backend  (Python, port 5000)
        |
        |── [optional] upload frame ──► Amazon S3  (frames/<uuid>.png)
        |
        |── Bearer token auth ──► Amazon Bedrock
        |                         (us.anthropic.claude-sonnet-4-6)
        |                         Cross-region inference profile
        |
        |── [optional] delete frame ──► Amazon S3  (cleanup)
        |
        └── return JSON ──► Browser
              { latex, explanation, confidence }
```

> **Auth note:** Bedrock calls use a **long-term Bedrock API key** (`BEDROCK_API_KEY`)
> passed as `Authorization: Bearer <key>`. No IAM SigV4 signing required.
> S3 archiving is a separate optional feature that only activates when
> `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `S3_BUCKET_NAME` are all set.

---

## Prerequisites

- Python 3.10+
- An AWS account with Bedrock access enabled for `us.anthropic.claude-sonnet-4-6`
- A **Bedrock API key** generated from *AWS Console → Amazon Bedrock → API keys*
- *(Optional)* An S3 bucket for frame archiving, with IAM credentials

---

## Setup

### 1 — Clone

```bash
git clone https://github.com/ple0309/CloudHacks-UCI-2026.git
cd CloudHacks-UCI-2026
```

### 2 — Install dependencies

```bash
pip install -r backend/requirements.txt
```

### 3 — Configure environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and fill in your keys:

```
# Required — Bedrock API key from AWS Console → Bedrock → API keys
BEDROCK_API_KEY=ABSKQm...

# AWS region (Bedrock must be enabled here)
AWS_REGION=us-east-1

# Cross-region inference profile ID for Claude Sonnet 4.6
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6

# Optional — S3 frame archiving (leave blank to skip)
S3_BUCKET_NAME=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

> **Never commit `backend/.env`** — it is listed in `.gitignore`.

### 4 — Run the backend

```bash
cd backend
python app.py
# Flask listening on http://127.0.0.1:5000
```

Expected startup output:
```
INFO:bedrock_model:S3 archiving disabled — no IAM credentials or bucket configured
 * Running on http://127.0.0.1:5000
```

### 5 — Serve the frontend

**Important: open via HTTP, not as a `file://` URL.** Browsers block cross-origin
fetch from `file://` pages, so the camera feed will connect but API calls will fail silently.

```bash
# In a second terminal
cd frontend
python -m http.server 8080
# Visit http://localhost:8080
```

---

## Running — at a glance

| Terminal | Directory | Command | Purpose |
|---|---|---|---|
| 1 | `backend/` | `python app.py` | Flask API on port 5000 |
| 2 | `frontend/` | `python -m http.server 8080` | Static files on port 8080 |

Then open **http://localhost:8080** in your browser and click **Start Camera**.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check string |
| `/health` | GET | `{ "status": "ok", "model": "bedrock" }` |
| `/analyze` | POST | Accepts `image` (multipart/form-data), returns JSON |

**Response shape (fixed contract):**

```json
{
  "latex": "\\frac{d}{dx}[f(x)g(x)] = f'(x)g(x) + f(x)g'(x)",
  "explanation": "This is the product rule for derivatives...",
  "confidence": "high"
}
```

---

## Project Structure

```
CloudHacks-UCI-2026/
├── backend/
│   ├── app.py              # Flask entrypoint — load_dotenv, /health, /analyze
│   ├── ai_interface.py     # Abstract AIModel base class
│   ├── bedrock_model.py    # Bedrock API key auth (Bearer token via requests)
│   ├── mock_model.py       # Rotating canned responses (offline dev only)
│   ├── prompts.py          # SYSTEM_PROMPT + USER_PROMPT for Claude
│   ├── formatter.py        # Normalises { latex, explanation, confidence }
│   ├── requirements.txt    # Pinned Python dependencies
│   ├── .env                # Secrets — git-ignored, NEVER committed
│   └── .env.example        # Safe-to-commit template
├── frontend/
│   ├── index.html          # MathJax config, aria-live regions, landmarks
│   ├── script.js           # Camera, 2s polling, fetch, MathJax, TTS, warnings
│   └── style.css           # Dark theme, confidence badges, warning banner
├── .gitignore              # Ignores *.env, __pycache__, .DS_Store, etc.
└── README.md
```

---

## Accessibility Features

- **`aria-live="polite"`** region auto-announces new explanations to screen readers on every update
- **`aria-live="assertive"`** warning banner fires immediately for low confidence or connection errors
- **`aria-label`** on all interactive controls, video feed, and result panels
- **`<main>` landmark** with descriptive label for keyboard and screen-reader navigation
- **Read Aloud** button triggers Web Speech API for fully hands-free use
- **Confidence badge** colour-coded: green (high) / orange (medium) / yellow (low)
- **Warning banner** appears automatically when confidence is low: *"Low confidence — please reposition camera"*

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Connection error" banner | Frontend opened as `file://` | Serve via `python -m http.server 8080` |
| `400 Bad Request` from Bedrock | Wrong model ID format | Use `us.anthropic.claude-sonnet-4-6` (cross-region prefix required) |
| `401 / 403` from Bedrock | Invalid or expired API key | Regenerate key in AWS Console → Bedrock → API keys |
| S3 archiving disabled log | No IAM credentials set | Expected — leave blank if not using S3 |

---

## Roadmap

- [ ] Swap Web Speech API for **Amazon Polly** (higher quality, language options)
- [ ] Stream frames over **WebSocket** instead of HTTP polling
- [ ] Support **PDF / image upload** as an alternative to webcam
- [ ] Deploy backend to **AWS Lambda + API Gateway** for zero-server demo

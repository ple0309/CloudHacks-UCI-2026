# MuTeX — Accessible AI Study Platform

> **CloudHacks UCI 2026** · Built for students with disabilities who deserve equal access to STEM.

MuTeX turns any math — handwritten or printed — into LaTeX, a rendered equation, a plain-English explanation, and a spoken answer, all in real time. A disability-profile onboarding screen adapts the entire interface before the student ever sees the main view.

---

## Demo

```bash
cd backend
python app.py
```

Open **http://localhost:5000** in Chrome, then:

1. Pick your accessibility profile on the onboarding screen
2. Click **Start Camera** and hold math up to the webcam
3. Select **Motor disability** or **Multiple needs** to unlock Voice Study Mode
4. Tap **🎙 Always On** — speak any time, hands-free, the tutor responds and talks back automatically

---

## What It Does

### Math Transcription (all profiles)
- Webcam frame captured every 2 s and sent to **Amazon Bedrock (Claude Sonnet 4.6)**
- Returns LaTeX, rendered via **MathJax**, with a plain-English explanation
- System prompt personalised per disability profile — descriptive for visual, step-by-step for cognitive, etc.
- Confidence badge (green / orange / yellow) tells the student when to reposition

### Voice Study Mode (motor / multi profiles)
| Capability | How |
|---|---|
| **Always-On continuous listening** | Tap once — mic stays open, auto-restarts after every answer |
| **Hold-to-speak (push-to-talk)** | Press and hold the mic button for a single question |
| **Sees the board** | Current webcam frame is captured and sent alongside every voice question — Claude answers based on what it sees **and** what the student says |
| **Sentence-level audio streaming** | Answer split into sentences, each synthesized by Polly/TTS in sequence — first audio plays ~400ms after Bedrock responds |
| **Follow-up chips** | Two AI-generated follow-up questions appear after every answer — tap to continue without re-speaking |
| **Conversation memory** | Last 4 turns sent as context — Claude remembers what was just discussed |

### Real-Time Conversation Loop (Always-On)
```
Student speaks  →  mic stops  →  Bedrock answers (sees board + hears question)
    →  Web Speech / Polly reads answer aloud  →  mic restarts automatically
```
The mic only opens **after** audio finishes, preventing the computer's voice from being re-captured.

---

## Disability Profiles

| Profile | Voice In | Voice Out | UI Extras |
|---|---|---|---|
| Visual impairment | — | TTS / Polly | High contrast, descriptive explanations |
| Motor disability | ✓ Always-On / Hold | TTS / Polly | Hands-free, voice-first |
| Learning difference | — | TTS / Polly | Simplified UI, step-by-step answers |
| Deaf / hard of hearing | — | — | Captions only, zero audio dependency |
| Multiple needs | ✓ Always-On / Hold | TTS / Polly | All features active |

---

## Architecture

```
Browser (Vanilla JS + MathJax 3)
  │
  ├─ Camera frame every 2s ──── POST /analyze ──────► Flask ──► BedrockModel
  │  (multipart + profile JSON)                                   profile-aware vision prompt
  │  ◄── { latex, explanation, confidence } ────────────────────────────────
  │
  ├─ Always-On / Hold mic ────── POST /voice/stream ─► Flask ──► VoiceModel
  │  (browser STT → plain text)                                   ├─ answer_question()  → Bedrock
  │  (+ current board frame as JPEG)                              │  max_tokens = 350
  │                                                               └─ synthesize_speech() → Polly
  │                                                                  per sentence, streamed via SSE
  │  ◄── SSE: { answer } then { audio_b64 } per sentence ───────────────────
  │
  └─ Audio queue drains sentence by sentence
     → mic auto-restarts after last sentence finishes (Always-On)
```

**Speed optimisations:**
- `max_tokens = 350` — short answers, faster Bedrock generation
- Polly input trimmed to 800 chars — synthesis in ~800ms
- First sentence audio arrives ~400ms after Bedrock responds (sentence streaming)
- Base64 audio embedded in SSE — no S3 round-trip (~400ms saved)
- Browser STT fires on first speech result — instant transcript dispatch

---

## AWS Services

| Service | Purpose | Auth |
|---|---|---|
| **Amazon Bedrock** — Claude Sonnet 4.6 | Vision OCR + conversational voice answers | Bedrock API key (Bearer token) |
| **Amazon Polly** | Neural TTS for Voice Study Mode | IAM — `polly:SynthesizeSpeech` only |
| **Amazon S3** | *(Optional)* Temporary frame archive | IAM — `s3:PutObject` + `s3:DeleteObject` |

> **No Amazon Transcribe.** The browser's `SpeechRecognition` API handles all STT — zero cost, zero latency.  
> **Polly is optional.** If IAM credentials are not set, the browser's Web Speech API speaks the answers automatically.

---

## Setup

### Prerequisites
- Python 3.10+
- AWS account with Bedrock enabled for `us.anthropic.claude-sonnet-4-6`
- Bedrock API key — AWS Console → Amazon Bedrock → API keys
- *(Optional)* IAM user with `polly:SynthesizeSpeech` for Polly neural voice

### Install

```bash
git clone https://github.com/ple0309/CloudHacks-UCI-2026.git
cd CloudHacks-UCI-2026
pip install -r backend/requirements.txt
```

### Configure

```bash
cp backend/.env.example backend/.env
```

Fill in `backend/.env`:

```env
# Required
BEDROCK_API_KEY=your-key-here
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6
AWS_REGION=us-east-1

# Optional — leave blank to fall back to browser Web Speech API
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

> `backend/.env` is git-ignored and never committed.

### Run

```bash
cd backend
python app.py
```

Open **http://localhost:5000** — Flask serves the frontend and API on one port. Hard-refresh with **Cmd+Shift+R** after restarting to pick up JS/CSS changes.

---

## API Reference

| Endpoint | Method | Body / Params | Returns |
|---|---|---|---|
| `/health` | GET | — | `{ status, model }` |
| `/profile` | GET | `?disability=motor` | Merged profile preset |
| `/profile` | POST | `{ disability, overrides }` | Profile with custom overrides |
| `/analyze` | POST | multipart `image` + `profile` | `{ latex, explanation, confidence }` |
| `/voice` | POST | `{ transcript, profile, context, image_b64 }` | `{ answer, follow_up, audio_b64, … }` |
| `/voice/stream` | POST | `{ transcript, profile, context, image_b64 }` | SSE stream of `answer`, `audio`, `done` events |

**`/voice/stream` SSE event types:**
```
{ type: "answer",  text, subject, confidence }   ← arrives first, updates UI text
{ type: "audio",   b64 }                          ← one per sentence, plays in sequence
{ type: "done",    follow_up }                    ← renders follow-up chips
{ type: "error",   message }                      ← on failure
```

**`/voice` returns 403** if the profile has `voice_input: false`.  
**`/voice` returns 400** if `transcript` is empty.

---

## Project Structure

```
CloudHacks-UCI-2026/
├── backend/
│   ├── app.py            Flask — all routes including /voice/stream (SSE)
│   ├── profile.py        ProfileManager: presets + system prompt builder
│   ├── bedrock_model.py  Vision OCR via Bedrock (requests + Bearer token)
│   ├── voice_model.py    Bedrock answers + Polly synthesis + board image support
│   ├── prompts.py        USER_PROMPT for /analyze image payloads
│   ├── formatter.py      Normalises { latex, explanation, confidence }
│   ├── ai_interface.py   Abstract AIModel base class
│   ├── requirements.txt
│   ├── .env              ← your secrets, git-ignored
│   └── .env.example      safe-to-commit template
├── frontend/
│   ├── index.html        Onboarding modal, Always-On toggle, voice panel, MathJax, ARIA
│   ├── script.js         Camera loop, profile system, Voice Study Mode, SSE audio queue
│   └── style.css         Dark theme, onboarding cards, voice panel, pulsing always-on indicator
├── .gitignore
└── README.md
```

---

## Minimal IAM Policy (Polly only)

```json
{
  "Effect": "Allow",
  "Action": ["polly:SynthesizeSpeech"],
  "Resource": "*"
}
```

---

## Accessibility Standards Met

- `aria-live="polite"` — explanation and voice status regions announce updates to screen readers
- `aria-live="assertive"` — warning banner fires immediately for errors
- `role="dialog"` + `aria-modal="true"` on onboarding overlay
- `aria-pressed` on the Always-On toggle reflects current state
- All profile cards keyboard-navigable (Tab to focus, Enter / Space to select)
- `body.high-contrast` and `body.simplified` CSS modifiers toggled from profile data

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `400` from Bedrock | Wrong model ID format | Use `us.anthropic.claude-sonnet-4-6` |
| `403` from `/voice` | Profile has `voice_input: false` | Select Motor or Multi profile |
| No audio in Voice Mode | Polly IAM creds not set | Expected — browser Web Speech API speaks automatically |
| "Connection error" in browser | Opened as `file://` | Visit `http://localhost:5000` |
| Mic not working in Chrome | Needs HTTPS or localhost | Confirm URL is `localhost`, not an IP |
| Old JS/CSS after restart | Browser cache | Hard-refresh with Cmd+Shift+R |

---

## Roadmap

- [ ] Deploy to AWS Lambda + API Gateway (serverless, shareable link)
- [ ] Amazon Polly SSML for more natural speech pacing
- [ ] PDF / image file upload as webcam alternative
- [ ] Per-student profile persistence in DynamoDB
- [ ] Upgrade to Amazon Nova Pro for even faster vision inference

"""
Option A Voice Model — Browser SpeechRecognition for STT (zero latency),
Amazon Bedrock for answers, Amazon Polly for neural voice output.

Supports "sees the board": caller may pass image_b64 (JPEG) so that
Bedrock can see the current webcam frame alongside the student's question.
"""

import os
import json
import base64
import logging

import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)


class VoiceModel:

    def __init__(self):
        self.region = os.getenv("AWS_REGION", "us-east-1")
        self.bedrock_api_key = os.getenv("BEDROCK_API_KEY")
        self.model_id = os.getenv("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
        self.bedrock_url = (
            f"https://bedrock-runtime.{self.region}.amazonaws.com"
            f"/model/{self.model_id}/invoke"
        )

        # Polly requires IAM credentials — optional, frontend falls back to Web Speech API
        access_key = os.getenv("AWS_ACCESS_KEY_ID")
        secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        if access_key and secret_key:
            import boto3
            self.polly = boto3.client(
                "polly",
                region_name=self.region,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
            )
            logger.info("Polly client initialised")
        else:
            self.polly = None
            logger.warning("No IAM creds — Polly disabled, frontend uses Web Speech API fallback")

    @staticmethod
    def _format_board_context(board_context: dict) -> str:
        """
        Format the board_context dict sent by the frontend into a text block
        that is injected before the student's question so Bedrock has full context.
        """
        if not board_context:
            return ""

        parts = []

        latex = board_context.get("last_latex", "")
        explanation = board_context.get("last_explanation", "")
        if latex:
            parts.append(f"Current math problem on the board: {latex}")
        if explanation:
            parts.append(f"Plain English: {explanation}")

        rec_list = board_context.get("recommendations", [])
        if rec_list:
            labeled = " | ".join(
                f"Problem {i+1}: {r.get('text', '')}"
                for i, r in enumerate(rec_list)
            )
            parts.append(
                f"Practice problem chips currently shown to the student "
                f"(numbered for reference): {labeled}. "
                f"When the student says 'solve problem 1' or 'problem 2', "
                f"they mean the corresponding question above."
            )

        return "\n".join(parts)

    def answer_question(
        self,
        transcript: str,
        profile: dict,
        context: list = None,
        image_b64: str = None,       # JPEG base64 from current webcam frame
        board_context: dict = None,  # rec chips + last LaTeX (for problem resolution)
    ) -> dict:
        """
        Send the student's spoken question to Bedrock and return a structured answer.

        image_b64: when provided, Claude sees the current board/worksheet alongside
                   the question — enables "what does this mean?" style queries.

        RULE 1: max_tokens = 350 — short answers only.
        RULE 5: context capped at 4 turns.
        """
        from profile import ProfileManager
        pm = ProfileManager()
        system_prompt = pm.build_voice_prompt(profile)

        # RULE 5 — enforce max 4 context turns
        safe_context = (context or [])[-4:]

        messages = list(safe_context)

        # Format board context (rec chips + last LaTeX) into a text prefix
        ctx_text = self._format_board_context(board_context or {})

        # Build the user message — include board image when available
        if image_b64:
            text_body = (
                "[The student's current board or worksheet is shown in the image above.]\n\n"
                + (f"[Board context]\n{ctx_text}\n\n" if ctx_text else "")
                + f"Student question: {transcript}"
            )
            user_content = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": image_b64,
                    },
                },
                {"type": "text", "text": text_body},
            ]
        elif ctx_text:
            user_content = f"[Board context]\n{ctx_text}\n\nStudent question: {transcript}"
        else:
            user_content = transcript

        messages.append({"role": "user", "content": user_content})

        payload = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 350,          # RULE 1 — short answers = faster Bedrock + faster Polly
            "system": system_prompt,
            "messages": messages,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.bedrock_api_key}",
        }

        raw = ""
        try:
            resp = requests.post(
                self.bedrock_url,
                json=payload,
                headers=headers,
                timeout=12,             # fail fast — do not hang the voice loop
            )
            if not resp.ok:
                logger.error("Bedrock /voice HTTP %s — %s", resp.status_code, resp.text[:300])
            resp.raise_for_status()

            raw = resp.json()["content"][0]["text"].strip()

            # Strip markdown fences if model wraps output despite instructions
            if raw.startswith("```"):
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]
            raw = raw.strip()

            result = json.loads(raw)
            return {
                "answer": str(result.get("answer", "")),
                "subject": str(result.get("subject", "general")),
                "follow_up": list(result.get("follow_up", []))[:2],
                "confidence": result.get("confidence", "medium"),
            }

        except (json.JSONDecodeError, KeyError) as exc:
            logger.warning("JSON parse failed: %s — raw: %s", exc, raw[:200])
            plain = raw if len(raw) < 500 else raw[:500]
            return {
                "answer": plain or "I could not generate an answer. Please try again.",
                "subject": "unknown",
                "follow_up": [],
                "confidence": "low",
            }
        except requests.RequestException as exc:
            logger.error("Bedrock request failed: %s", exc)
            raise

    def synthesize_speech(self, text: str, profile: dict) -> str | None:
        """
        Convert text to speech via Amazon Polly.

        RULE 2: trim to 800 chars before sending to Polly.
        RULE 4: return base64-encoded MP3 — NO S3 upload.

        Returns base64 MP3 string, or None if Polly unavailable.
        """
        if profile.get("captions_only"):
            return None

        if not self.polly:
            return None

        # RULE 2 — trim to 800 chars (keeps synthesis under ~800ms)
        trimmed = text[:800]
        voice_id = profile.get("polly_voice", "Joanna")

        try:
            response = self.polly.synthesize_speech(
                VoiceId=voice_id,
                Engine="neural",
                OutputFormat="mp3",
                Text=trimmed,
                TextType="text",
            )
            audio_bytes = response["AudioStream"].read()
            # RULE 4 — base64 encode, embed in JSON (saves one S3 round-trip ~400ms)
            return base64.b64encode(audio_bytes).decode("utf-8")

        except Exception as exc:
            logger.error("Polly synthesis failed: %s", exc)
            return None     # non-fatal — frontend falls back to Web Speech API

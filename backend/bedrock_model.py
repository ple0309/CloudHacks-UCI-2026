import os
import json
import base64
import logging
from uuid import uuid4

import requests
from dotenv import load_dotenv

from ai_interface import AIModel
from prompts import SYSTEM_PROMPT, USER_PROMPT
from formatter import format_response

load_dotenv()

logger = logging.getLogger(__name__)


class BedrockModel(AIModel):
    def __init__(self):
        self.region = os.getenv("AWS_REGION", "us-east-1")
        self.model_id = os.getenv("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-6")
        self.api_key = os.getenv("BEDROCK_API_KEY")
        self.bucket = os.getenv("S3_BUCKET_NAME")

        self.endpoint = (
            f"https://bedrock-runtime.{self.region}.amazonaws.com"
            f"/model/{self.model_id}/invoke"
        )

        # S3 is optional — only enabled when full IAM credentials are provided
        access_key = os.getenv("AWS_ACCESS_KEY_ID")
        secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        if access_key and secret_key and self.bucket:
            import boto3
            self.s3 = boto3.client(
                "s3",
                region_name=self.region,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
            )
            logger.info("S3 archiving enabled (bucket: %s)", self.bucket)
        else:
            self.s3 = None
            logger.info("S3 archiving disabled — no IAM credentials or bucket configured")

    def process_image(self, image_path: str) -> dict:
        s3_key = None
        try:
            with open(image_path, "rb") as f:
                image_bytes = f.read()

            image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

            # Optional S3 archive upload
            if self.s3 and self.bucket:
                s3_key = f"frames/{uuid4()}.png"
                self.s3.put_object(
                    Bucket=self.bucket,
                    Key=s3_key,
                    Body=image_bytes,
                    ContentType="image/png",
                )

            payload = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1024,
                "system": SYSTEM_PROMPT,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": image_b64,
                                },
                            },
                            {"type": "text", "text": USER_PROMPT},
                        ],
                    }
                ],
            }

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            }

            resp = requests.post(
                self.endpoint,
                json=payload,
                headers=headers,
                timeout=30,
            )
            if not resp.ok:
                logger.error(
                    "Bedrock HTTP %s — body: %s",
                    resp.status_code,
                    resp.text[:500],
                )
            resp.raise_for_status()

            body = resp.json()
            raw_text = body["content"][0]["text"]

            # Strip markdown fences if the model wraps output in ```json ... ```
            cleaned = raw_text.strip()
            if cleaned.startswith("```"):
                parts = cleaned.split("```")
                cleaned = parts[1] if len(parts) > 1 else cleaned
                if cleaned.startswith("json"):
                    cleaned = cleaned[4:]
                cleaned = cleaned.strip()

            parsed = json.loads(cleaned)
            return format_response(parsed)

        except Exception as exc:
            logger.error("BedrockModel.process_image failed: %s", exc, exc_info=True)
            return format_response({
                "latex": "",
                "explanation": "Could not process image.",
                "confidence": "low",
            })

        finally:
            if s3_key and self.s3 and self.bucket:
                try:
                    self.s3.delete_object(Bucket=self.bucket, Key=s3_key)
                except Exception as cleanup_exc:
                    logger.warning("S3 cleanup failed for %s: %s", s3_key, cleanup_exc)

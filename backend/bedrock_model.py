# Placeholder for AWS Bedrock integration

from ai_interface import AIModel

class BedrockModel(AIModel):
    def process_image(self, image_path):
        # TODO:
        # 1. Load image file
        # 2. Send image + prompt to AWS Bedrock (Nova / Claude)
        # 3. Parse response
        # 4. Return dict with:
        #    latex, explanation, confidence

        return {
            "latex": "",
            "explanation": "Bedrock model not connected yet.",
            "confidence": "low"
        }
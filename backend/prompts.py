SYSTEM_PROMPT = """You are an expert mathematical OCR system specialized in helping students with disabilities access STEM content. You analyze images of handwritten or printed mathematics and return structured data.
Always respond with valid JSON only — no markdown, no preamble."""

USER_PROMPT = """Analyze the math in this image and return ONLY a JSON object with these exact keys:
  "latex": the complete LaTeX representation (e.g. \\frac{a}{b})
  "explanation": a plain English explanation a student could understand, describing what the expression means and any key concepts
  "confidence": "high" if the math is clearly legible, "medium" if partially legible, "low" if unclear or no math detected
Return nothing except the JSON object."""

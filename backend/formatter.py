def format_response(raw):
    return {
        "latex": raw.get("latex", ""),
        "explanation": raw.get("explanation", ""),
        "confidence": raw.get("confidence", "unknown")
    }
from ai_interface import AIModel

class MockModel(AIModel):
    def __init__(self):
        self.counter = 0

    def process_image(self, image_path):
        self.counter += 1

        # Rotate between a few mock cases
        cases = [
            {
                "latex": r"\frac{x+1}{x-1}",
                "explanation": "This is a fraction with numerator x plus 1 and denominator x minus 1.",
                "confidence": "high"
            },
            {
                "latex": r"\int x^2 \, dx",
                "explanation": "This is the integral of x squared with respect to x.",
                "confidence": "medium"
            },
            {
                "latex": "",
                "explanation": "Image unclear, please move closer and try again.",
                "confidence": "low"
            }
        ]

        return cases[self.counter % len(cases)]
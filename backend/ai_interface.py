# Base interface for AI models

class AIModel:
    def process_image(self, image_path):
        raise NotImplementedError("Must implement process_image()")
from dotenv import load_dotenv

load_dotenv()


class ProfileManager:

    DEFAULT_PROFILE = {
        "userId": None,
        "disability": "visual",
        "level": "standard",
        "voice_input": False,
        "voice_output": True,
        "polly_voice": "Joanna",
        "tts_speed": 1.0,
        "high_contrast": False,
        "simplified_ui": False,
        "audio_only": False,
        "captions_only": False,
        "explanation_style": "standard",
    }

    DISABILITY_PRESETS = {
        "visual": {
            "voice_input": False,
            "voice_output": True,
            "high_contrast": True,
            "audio_only": False,
            "explanation_style": "descriptive",
            "polly_voice": "Joanna",
        },
        "motor": {
            "voice_input": True,
            "voice_output": True,
            "high_contrast": False,
            "simplified_ui": False,
            "explanation_style": "standard",
            "polly_voice": "Matthew",
        },
        "cognitive": {
            "voice_input": False,
            "voice_output": True,
            "simplified_ui": True,
            "level": "beginner",
            "explanation_style": "stepwise",
            "polly_voice": "Joanna",
        },
        "hearing": {
            "voice_input": False,
            "voice_output": False,
            "captions_only": True,
            "explanation_style": "standard",
        },
        "multi": {
            "voice_input": True,
            "voice_output": True,
            "high_contrast": True,
            "explanation_style": "descriptive",
        },
    }

    def get_preset(self, disability: str) -> dict:
        """Merge DEFAULT_PROFILE with disability preset. Never mutate DEFAULT."""
        if disability not in self.DISABILITY_PRESETS:
            raise ValueError(f"Unknown disability preset: {disability}")
        merged = dict(self.DEFAULT_PROFILE)
        merged.update(self.DISABILITY_PRESETS[disability])
        merged["disability"] = disability
        return merged

    def apply_overrides(self, profile: dict, overrides: dict) -> dict:
        """Apply user-supplied overrides on top of a preset profile."""
        result = dict(profile)
        result.update(overrides)
        return result

    def build_system_prompt(self, profile: dict) -> str:
        """
        Assemble the Bedrock system prompt from the profile.
        Called for BOTH /analyze and /voice.
        """
        parts = [
            "You are an expert STEM tutor helping a student with a "
            "disability access academic content."
        ]

        style = profile.get("explanation_style", "standard")
        if style == "descriptive":
            parts.append(
                "Use clear, vivid language. Never reference visual layout. "
                "Describe spatial relationships in words."
            )
        elif style == "stepwise":
            parts.append(
                "Break every answer into numbered steps. Use simple "
                "vocabulary (grade 8 level). After each answer, offer "
                "to explain it a different way."
            )
        else:
            parts.append("Be clear and concise.")

        level = profile.get("level", "standard")
        if level == "beginner":
            parts.append(
                "The student is a beginner. Avoid jargon. Use everyday analogies."
            )
        elif level == "advanced":
            parts.append(
                "The student is advanced. You may use technical terminology."
            )

        if profile.get("captions_only"):
            parts.append(
                "Never refer to audio or sound. All output must be "
                "fully self-contained in text."
            )

        if profile.get("voice_output") and not profile.get("captions_only"):
            parts.append(
                "Your answer will be spoken aloud by Amazon Polly. "
                "Write in natural spoken English. "
                "Never use LaTeX symbols in the answer field — say "
                "'x squared' not 'x^2', 'pi' not '\\pi'. "
                "Answer in 2-4 sentences maximum. Never use bullet points."
            )

        parts.append("Respond ONLY with valid JSON. No markdown fences, no preamble.")
        return " ".join(parts)

    def build_voice_prompt(self, profile: dict) -> str:
        """
        Tighter prompt for /voice — enforces short answers because every extra
        sentence costs ~200ms of Polly synthesis time (RULE 1).
        """
        base = self.build_system_prompt(profile)
        voice_rule = (
            " CRITICAL: Answers must be 2-3 sentences only. "
            "You are in a real-time voice conversation. Brevity is essential. "
            "Return JSON with keys: answer (str), subject (str), "
            "follow_up (list of exactly 2 short question strings), "
            "confidence (str: high|medium|low). "
            "If the student references 'problem 1', 'problem 2', 'the first one', "
            "'option 1', 'the second one', or any numbered problem, resolve it "
            "from the practice recommendations in the board context and solve it "
            "fully. Never say you cannot find it. "
            "follow_up must always contain exactly 2 objects, each with keys "
            "\"text\" (str, ≤12 words, starts with a verb) and "
            "\"latex\" (str — problem expression only, not the solution). "
        )
        return base + voice_rule

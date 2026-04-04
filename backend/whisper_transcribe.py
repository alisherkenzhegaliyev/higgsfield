import os
import re
import base64
import tempfile
from groq import Groq

client = Groq(api_key=os.environ["GROQ_API_KEY"])


def transcribe(audio_b64: str) -> str:
    audio_bytes = base64.b64decode(audio_b64)
    with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
        f.write(audio_bytes)
        fname = f.name
    with open(fname, 'rb') as af:
        result = client.audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=af,
            language="ru",
            prompt="Хиггс.",
        )
    text = result.text.strip()
    if len(text) < 3:
        return ""

    low = text.lower()

    # Hard hallucination strings
    HALLUCINATIONS = {
        "thank you", "thanks for watching", "bye", "goodbye",
        "subscribe", "you", ".", "thanks.",
    }
    if low in HALLUCINATIONS:
        return ""

    # Prompt echo detection — if 4+ of our prompt words appear it's an echo
    PROMPT_WORDS = {"higgs", "canvas", "uml", "diagram", "flowchart", "brainstorm", "sticky", "note"}
    words = set(re.sub(r"[^a-z ]", "", low).split())
    if len(words & PROMPT_WORDS) >= 4:
        return ""

    return text

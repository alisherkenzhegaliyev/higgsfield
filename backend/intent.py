import os
import anthropic

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

CLASSIFIER_SYSTEM = """\
You are a classifier for a voice-controlled whiteboard canvas called Higgs.

Decide if the user's transcribed speech is a command to create, modify, or organize something on the canvas.

Reply with exactly one word: YES or NO.

Canvas commands include: creating diagrams, flowcharts, mind maps, UML, sticky notes, shapes, arrows, text labels, moving or deleting things.
NOT canvas commands: casual conversation, thinking out loud, greetings, questions to each other, unrelated topics.

Examples:
  "let's draw a flowchart for the login flow" → YES
  "Higgs create a UML diagram" → YES
  "make a mind map about climate change" → YES
  "add a sticky note saying TODO" → YES
  "yeah that makes sense" → NO
  "I think we should use React" → NO
  "what do you think about this?" → NO
  "ok so anyway" → NO\
"""


def is_canvas_command(transcript: str) -> bool:
    """Return True if the transcript looks like a canvas command."""
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=5,
        system=CLASSIFIER_SYSTEM,
        messages=[{"role": "user", "content": transcript}],
    )
    return response.content[0].text.strip().upper().startswith("YES")


SYSTEM = """\
You are an intent extractor for a voice-controlled whiteboard canvas called Higgs.

The user spoke a command (possibly transcribed imperfectly by speech-to-text).
Your job is to extract the core intent as a clean, concise instruction for the canvas agent.

RULES:
- Remove the wake word "Higgs" and filler words ("um", "uh", "like", "you know", "please", "can you")
- Fix obvious speech-to-text errors based on context (e.g. "xcreateUML" → "create UML diagram")
- Infer missing details from context (e.g. "make a diagram" → "create a flowchart diagram")
- Output ONE clean imperative sentence describing what to draw/create/modify on the canvas
- If the command is ambiguous, make the most reasonable whiteboard-related interpretation
- Never output more than 2 sentences

Examples:
  Input: "Higgs um create like a UML you know diagram"
  Output: Create a UML class diagram.

  Input: "xcreateUML diagram flowchart"
  Output: Create a UML class diagram.

  Input: "Higgs create a sticky note at the top left corner summarizing what we discussed"
  Output: Create a sticky note at the top-left corner summarizing the discussion.

  Input: "Higgs скреет UML-диаграмму"
  Output: Create a UML class diagram.

Output ONLY the clean instruction, nothing else.\
"""


def extract_intent(raw_transcript: str) -> str:
    """Convert messy voice transcript into a clean canvas instruction."""
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=100,
        system=SYSTEM,
        messages=[{"role": "user", "content": raw_transcript}],
    )
    return response.content[0].text.strip()

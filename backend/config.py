from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = ""
    groq_api_key: str = ""
    hf_token: str = ""
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""

    canvas_agent_model: str = "llama-3.3-70b-versatile"
    chat_agent_model: str = "llama-3.3-70b-versatile"
    classifier_model: str = "llama-3.3-70b-versatile"
    llm_base_url: str = "https://api.groq.com/openai/v1"

    @property
    def llm_api_key(self) -> str:
        if "groq.com" in self.llm_base_url:
            return self.groq_api_key
        if "huggingface" in self.llm_base_url:
            return self.hf_token
        return self.anthropic_api_key or self.groq_api_key or self.hf_token

    command_flush_delay_s: float = 3.5
    db_save_debounce_s: float = 2.0
    agent_max_turns: int = 8
    context_debug: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()

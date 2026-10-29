class ProviderRequest:  # 占位：兼容层不内置 LLM
    def __init__(self, prompt: str = "", system_prompt: str = "", **kw):
        self.prompt = prompt
        self.system_prompt = system_prompt
        self.__dict__.update(kw)


class LLMResponse:
    def __init__(self, role: str = "assistant", completion_text: str = "", **kw):
        self.role = role
        self.completion_text = completion_text
        self.__dict__.update(kw)

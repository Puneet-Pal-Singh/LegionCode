interface ModelDisplaySource {
  id: string;
  name: string;
}

const MODEL_WORDS: Record<string, string> = {
  chatgpt: "ChatGPT",
  code: "Code",
  davinci: "Davinci",
  embedding: "Embedding",
  flash: "Flash",
  free: "Free",
  glm: "GLM",
  gpt: "GPT",
  image: "Image",
  instruct: "Instruct",
  latest: "Latest",
  luna: "Luna",
  mini: "Mini",
  nano: "Nano",
  preview: "Preview",
  realtime: "Realtime",
  small: "Small",
  text: "Text",
  turbo: "Turbo",
};

export function formatModelDisplayName(model: ModelDisplaySource): string {
  const rawName = model.name.trim() || model.id.trim();
  if (/[A-Z]/.test(rawName)) {
    return rawName;
  }

  const unqualifiedName = rawName.split("/").at(-1) ?? rawName;
  const tokens = unqualifiedName.split(/[-_: ]+/).filter(Boolean);
  if (tokens.length === 0) {
    return rawName;
  }

  const formattedTokens = tokens.map((token) => {
    const knownWord = MODEL_WORDS[token];
    if (knownWord) return knownWord;
    if (/^\d|^o\d/i.test(token)) return token;
    return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
  });

  if (formattedTokens[0] === "GPT" && /^\d/.test(formattedTokens[1] ?? "")) {
    return [`GPT-${formattedTokens[1]}`, ...formattedTokens.slice(2)].join(" ");
  }

  return formattedTokens.join(" ");
}

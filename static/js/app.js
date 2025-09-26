document.addEventListener("DOMContentLoaded", () => {
  const el = (s) => document.querySelector(s);
  const converter = new showdown.Converter({
    ghCompatibleHeaderId: true,
    simpleLineBreaks: true,
    simplifiedAutoLink: true,
    strikethrough: true,
    tables: true,
    tasklists: true,
    openLinksInNewWindow: true,
    emoji: true,
  });

  // --- State ---
  let controller = null; // AbortController for streaming
  let visionAttachment = null; // { data: base64, name: string, type: string }

  // --- Elements ---
  const chat = el("#chat");
  const userInput = el("#userInput");
  const sendBtn = el("#sendBtn");
  const stopBtn = el("#stopBtn");
  const clearChatBtn = el("#clearChat");
  const sessionStats = el("#sessionStats");

  // Settings Drawer
  const settingsOverlay = el("#settingsOverlay");
  const settingsDrawer = el("#settingsDrawer");
  const openSettingsBtn = el("#openSettings");
  const closeSettingsBtn = el("#closeSettings");
  const saveSettingsBtn = el("#saveSettings");
  const settingsForm = el("#settingsForm");

  // Setting fields
  const baseUrlInp = el("#baseUrl");
  const modelSelect = el("#modelSelect");
  const modelIdInp = el("#modelId");
  const refreshModelsBtn = el("#refreshModels");
  const apiKeyInp = el("#apiKey");
  const systemPromptInp = el("#systemPrompt");
  const tempInp = el("#temperature");
  const tempVal = el("#tempVal");
  const maxTokensInp = el("#maxTokens");
  const imageDetailSelect = el("#imageDetail");
  const imageDetailWrapper = el("#imageDetailWrapper");

  // Vision
  const visionTools = el("#visionTools");
  const imageUploadBtn = el("#imageUploadBtn");
  const cameraCaptureBtn = el("#cameraCaptureBtn");
  const imageFileInput = el("#imageFileInput");
  const cameraFileInput = el("#cameraFileInput");
  const imagePreview = el("#imagePreview");
  const imagePreviewImg = el("#imagePreviewImg");
  const imagePreviewMeta = el("#imagePreviewMeta");
  const removeImageBtn = el("#removeImageBtn");
  const visionActions = el("#visionActions");

  // Prompt Library
  const savePromptBtn = el("#savePromptBtn");
  const promptLibrarySelect = el("#promptLibrarySelect");

  // --- Toasts ---
  const toast = el("#toast");
  const toastContent = toast.querySelector("div");
  let toastTimeout;
  function notify(msg, duration = 3000) {
    toastContent.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.add("hidden"), duration);
  }

  // --- Settings Management ---
  function loadSettings() {
    const s = JSON.parse(localStorage.getItem("settings") || "{}");
    baseUrlInp.value = s.baseUrl || window.DEFAULTS.baseUrl;
    modelIdInp.value = s.modelId || window.DEFAULTS.modelId;
    apiKeyInp.value = s.apiKey || "";
    systemPromptInp.value = s.systemPrompt || "You are a helpful assistant.";
    tempInp.value = s.temperature ?? 0.7;
    tempVal.textContent = parseFloat(tempInp.value).toFixed(1);
    maxTokensInp.value = s.maxTokens || "";
    imageDetailSelect.value = (s.imageDetail || "high");
    updateVisionTools();
    loadPromptLibrary();
  }

  function saveSettings() {
    const s = {
      baseUrl: baseUrlInp.value.trim(),
      modelId: modelIdInp.value.trim(),
      apiKey: apiKeyInp.value.trim(),
      systemPrompt: systemPromptInp.value.trim(),
      temperature: parseFloat(tempInp.value),
      maxTokens: maxTokensInp.value.trim(),
      imageDetail: (imageDetailSelect.value || "high"),
    };
    localStorage.setItem("settings", JSON.stringify(s));
    notify("Settings saved.");
    updateVisionTools();
    return s;
  }

  // --- Models ---
  async function fetchModels() {
    const url = baseUrlInp.value.trim();
    if (!url) {
      notify("Please enter a Base URL first.");
      return;
    }

    refreshModelsBtn.disabled = true;
    refreshModelsBtn.classList.add("animate-spin");
    modelSelect.innerHTML = '<option value="">Loading...</option>';

    try {
      const resp = await fetch(`/api/models?base_url=${encodeURIComponent(url)}&api_key=${encodeURIComponent(apiKeyInp.value.trim())}`);
      if (!resp.ok) throw new Error((await resp.json()).error || "Failed to fetch models.");

      const { models } = await resp.json();
      modelSelect.innerHTML = '<option value="">Select a model</option>';
      models.forEach(m => {
        const option = document.createElement("option");
        option.value = m.id;
        option.textContent = m.id;
        modelSelect.appendChild(option);
      });

      const currentModel = modelIdInp.value;
      if (models.some(m => m.id === currentModel)) {
        modelSelect.value = currentModel;
      }

    } catch (err) {
      notify(`Error: ${err.message}`);
      modelSelect.innerHTML = '<option value="">Could not load</option>';
    } finally {
      refreshModelsBtn.disabled = false;
      refreshModelsBtn.classList.remove("animate-spin");
    }
  }

  // --- Chat ---
  function addMessage(role, content, attachment = null) {
    const wrapper = document.createElement("div");
    wrapper.className = `flex w-full`;

    const bubble = document.createElement("div");
    bubble.className = `bubble max-w-[80%] rounded-2xl px-4 py-2.5`;

    if (role === "user") {
      wrapper.classList.add("justify-end");
      bubble.classList.add("bg-indigo-600", "text-white");
    } else {
      wrapper.classList.add("justify-start");
      bubble.classList.add("bg-slate-800", "text-slate-200");
    }

    if (attachment) {
      const img = document.createElement("img");
      img.src = attachment.data;
      img.alt = attachment.name;
      img.className = "attachment mb-2 max-w-full rounded-lg";
      bubble.appendChild(img);
    }

    const contentDiv = document.createElement("div");
    contentDiv.className = "prose prose-invert prose-sm max-w-none";
    contentDiv.innerHTML = content;
    bubble.appendChild(contentDiv);

    let footer = null;
    if (role === "ai") {
      footer = document.createElement("div");
      footer.className = "bubble-footer hidden";
      bubble.appendChild(footer);
    }

    wrapper.appendChild(bubble);
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;
    return { wrapper, bubble, content: contentDiv, footer };
  }

  function createFooterItem(icon, label, title = "") {
    const span = document.createElement("span");
    span.className = "bubble-footer__item";
    if (title) span.title = title;

    const iconSpan = document.createElement("span");
    iconSpan.className = "bubble-footer__icon";
    iconSpan.textContent = icon;
    span.appendChild(iconSpan);

    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    span.appendChild(labelSpan);

    return span;
  }

  function updateAssistantFooter(footerEl, metadata) {
    if (!footerEl) return;

    footerEl.innerHTML = "";
    const segments = [];

    const meta = metadata || {};
    const { prompt, completion, total, serverLatency, roundTripMs } = meta;

    if (typeof prompt === "number" && !Number.isNaN(prompt)) {
      segments.push(createFooterItem("🧠", `${prompt.toLocaleString()} prompt`));
    }
    if (typeof completion === "number" && !Number.isNaN(completion)) {
      segments.push(createFooterItem("✨", `${completion.toLocaleString()} completion`));
    }
    if (typeof total === "number" && !Number.isNaN(total)) {
      segments.push(createFooterItem("Σ", `${total.toLocaleString()} total`));
    }
    if (typeof serverLatency === "number" && !Number.isNaN(serverLatency)) {
      segments.push(createFooterItem("⚙️", `${serverLatency.toLocaleString()} ms`, "Server processing time"));
    }
    if (typeof roundTripMs === "number" && !Number.isNaN(roundTripMs)) {
      segments.push(createFooterItem("⏱️", `${roundTripMs.toLocaleString()} ms`, "Round-trip time"));
    }

    if (!segments.length) {
      footerEl.classList.add("hidden");
      return;
    }

    segments.forEach((segment) => footerEl.appendChild(segment));
    footerEl.classList.remove("hidden");
  }

  function updateSessionStats(totals) {
    if (!sessionStats) return;

    const hasTotals = totals && (typeof totals.total_tokens === "number" || typeof totals.prompt_tokens === "number" || typeof totals.completion_tokens === "number");
    if (!hasTotals) {
      sessionStats.classList.add("hidden");
      sessionStats.innerHTML = "";
      return;
    }

    const chips = [];
    const promptTokens = totals.prompt_tokens;
    const completionTokens = totals.completion_tokens;
    const totalTokens = totals.total_tokens;

    sessionStats.innerHTML = "";

    const label = document.createElement("span");
    label.className = "session-stats__label";
    label.textContent = "Session";
    sessionStats.appendChild(label);

    if (typeof promptTokens === "number") {
      chips.push(createFooterItem("🧠", `${promptTokens.toLocaleString()} prompt`));
    }
    if (typeof completionTokens === "number") {
      chips.push(createFooterItem("✨", `${completionTokens.toLocaleString()} completion`));
    }
    if (typeof totalTokens === "number") {
      chips.push(createFooterItem("Σ", `${totalTokens.toLocaleString()} total`));
    }

    chips.forEach((chip) => {
      chip.classList.add("session-stats__item");
      sessionStats.appendChild(chip);
    });

    sessionStats.classList.remove("hidden");
  }

  function getSettings() {
    return JSON.parse(localStorage.getItem("settings") || "{}");
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text && !visionAttachment) return;

    const settings = getSettings();
    if (!settings.modelId) {
      notify("Please select a model in settings.");
      return;
    }

    const imageDetail = settings.imageDetail || (imageDetailSelect ? imageDetailSelect.value : null) || "high";
    const attachment = visionAttachment;
    addMessage("user", text, attachment);
    userInput.value = "";
    userInput.style.height = "auto";
    if (attachment) {
      removeImage();
    }

    const aiMessage = addMessage("ai", "");
    const cursor = document.createElement("span");
    cursor.className = "typing";
    cursor.textContent = "▍";
    aiMessage.content.appendChild(cursor);

    sendBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    controller = new AbortController();

    const requestStarted = performance.now();

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          base_url: settings.baseUrl,
          api_key: settings.apiKey,
          model: settings.modelId,
          system_prompt: settings.systemPrompt,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          image_data: attachment ? attachment.data : null,
          image_name: attachment ? attachment.name : null,
          image_type: attachment ? attachment.type : null,
          image_detail: attachment ? imageDetail : null,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || "Request failed");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let responseText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        responseText += decoder.decode(value, { stream: true });
        chat.scrollTop = chat.scrollHeight;
      }

      try {
        const json = JSON.parse(responseText);
        if (json.reply) {
          const formattedReply = converter.makeHtml(json.reply);
          aiMessage.content.innerHTML = formattedReply;
        } else {
            aiMessage.content.textContent = responseText;
        }

        const usage = json.usage || {};
        const metadata = {
          prompt: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : Number.parseInt(usage.prompt_tokens, 10),
          completion: typeof usage.completion_tokens === "number" ? usage.completion_tokens : Number.parseInt(usage.completion_tokens, 10),
          total: typeof usage.total_tokens === "number" ? usage.total_tokens : Number.parseInt(usage.total_tokens, 10),
          serverLatency: typeof json.latency_ms === "number" ? json.latency_ms : Number.parseInt(json.latency_ms, 10),
          roundTripMs: Math.round(performance.now() - requestStarted),
        };

        updateAssistantFooter(aiMessage.footer, metadata);

        if (json.session_totals) {
          updateSessionStats(json.session_totals);
        }
      } catch (err) {
        aiMessage.content.textContent = responseText;
        updateAssistantFooter(aiMessage.footer, null);
      }

    } catch (err) {
      if (err.name !== 'AbortError') {
        aiMessage.content.textContent = `[Error: ${err.message}]`;
        updateAssistantFooter(aiMessage.footer, null);
      }
    } finally {
      aiMessage.content.querySelector(".typing")?.remove();
      sendBtn.classList.remove("hidden");
      stopBtn.classList.add("hidden");
      controller = null;
    }
  }

  async function resetChat() {
    try {
      await fetch("/api/reset", { method: "POST" });
      chat.innerHTML = '';
      addMessage('ai', 'Chat cleared.');
      updateSessionStats(null);
      removeImage();
      notify("Chat history has been cleared.");
    } catch (err) {
      notify(`Error clearing chat: ${err.message}`);
    }
  }

  // --- Vision ---
  function isVisionModel(modelId) {
    if (!modelId) return false;
    return modelId.toLowerCase().includes("magistral");
  }

  function updateVisionTools() {
    const storedSettings = getSettings();
    const activeModel = (modelIdInp.value || '').trim() || storedSettings.modelId;
    const supportsVision = isVisionModel(activeModel);

    if (supportsVision) {
      visionTools?.classList.remove("hidden");
    } else {
      visionTools?.classList.add("hidden");
      removeImage();
    }

    if (imageDetailSelect) {
      imageDetailSelect.disabled = !supportsVision;
    }
    if (imageDetailWrapper) {
      imageDetailWrapper.classList.toggle("opacity-50", !supportsVision);
    }
  }

  function handleFileSelect(file) {
    if (!file || !file.type.startsWith("image/")) {
      notify("Please select an image file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      visionAttachment = {
        data: e.target.result,
        name: file.name,
        type: file.type,
      };
      imagePreviewImg.src = e.target.result;
      imagePreviewMeta.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      imagePreview.classList.remove("hidden");
      visionActions.classList.add("hidden");
    };
    reader.readAsDataURL(file);
  }

  function removeImage() {
    visionAttachment = null;
    imagePreview.classList.add("hidden");
    visionActions.classList.remove("hidden");
    imageFileInput.value = "";
    cameraFileInput.value = "";
  }

  // --- Prompt Library ---
  const PROMPT_LIBRARY_KEY = "promptLibrary";
  function loadPromptLibrary() {
    const prompts = JSON.parse(localStorage.getItem(PROMPT_LIBRARY_KEY) || "[]");
    promptLibrarySelect.innerHTML = '<option value="">Load from Library</option>';
    prompts.forEach(p => {
      const option = document.createElement("option");
      option.value = p.prompt;
      option.textContent = p.name;
      promptLibrarySelect.appendChild(option);
    });
  }

  function savePrompt() {
    const name = prompt("Enter a name for this prompt:");
    if (!name || !name.trim()) return;

    const prompts = JSON.parse(localStorage.getItem(PROMPT_LIBRARY_KEY) || "[]");
    prompts.push({ name: name.trim(), prompt: systemPromptInp.value });
    localStorage.setItem(PROMPT_LIBRARY_KEY, JSON.stringify(prompts));
    loadPromptLibrary();
    notify(`Prompt "${name}" saved.`);
  }

  // --- Event Listeners ---
  sendBtn.addEventListener("click", sendMessage);
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  stopBtn.addEventListener("click", () => {
    if (controller) controller.abort();
  });

  clearChatBtn.addEventListener("click", resetChat);

  // Settings Drawer
  openSettingsBtn.addEventListener("click", () => {
    settingsOverlay.classList.remove("hidden");
    settingsDrawer.classList.remove("translate-x-full");
  });

  const closeDrawer = () => {
    settingsOverlay.classList.add("hidden");
    settingsDrawer.classList.add("translate-x-full");
  };
  closeSettingsBtn.addEventListener("click", closeDrawer);
  settingsOverlay.addEventListener("click", closeDrawer);

  settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings();
    closeDrawer();
  });
  saveSettingsBtn.addEventListener("click", (e) => {
     e.preventDefault();
    saveSettings();
    closeDrawer();
  });

  // Model handling
  refreshModelsBtn.addEventListener("click", fetchModels);
  modelSelect.addEventListener("change", () => {
    modelIdInp.value = modelSelect.value;
    updateVisionTools();
  });
  modelIdInp.addEventListener("input", updateVisionTools);
  baseUrlInp.addEventListener("change", fetchModels);

  // Temperature slider
  tempInp.addEventListener("input", () => {
    tempVal.textContent = parseFloat(tempInp.value).toFixed(1);
  });

  // Vision
  imageUploadBtn.addEventListener("click", () => imageFileInput.click());
  cameraCaptureBtn.addEventListener("click", () => cameraFileInput.click());
  imageFileInput.addEventListener("change", (e) => handleFileSelect(e.target.files[0]));
  cameraFileInput.addEventListener("change", (e) => handleFileSelect(e.target.files[0]));
  removeImageBtn.addEventListener("click", removeImage);

  // Prompt Library
  savePromptBtn.addEventListener("click", savePrompt);
  promptLibrarySelect.addEventListener("change", () => {
    if (promptLibrarySelect.value) {
      systemPromptInp.value = promptLibrarySelect.value;
    }
  });

  // Auto-resize textarea
  userInput.addEventListener("input", () => {
    userInput.style.height = "auto";
    userInput.style.height = `${Math.min(userInput.scrollHeight, 160)}px`;
  });

  // --- Init ---
  loadSettings();
  updateSessionStats(null);
  fetchModels();
});

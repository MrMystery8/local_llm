const { useState, useCallback, useEffect, useMemo, useRef } = React;

const defaultsSource = window.DEFAULTS || {};
const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: defaultsSource.baseUrl || '',
  modelId: defaultsSource.modelId || '',
  apiKey: 'lm-studio',
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: ''
});

const WELCOME_MESSAGE = {
  id: 'assistant-welcome',
  role: 'assistant',
  content: "Hey there! I'm your local copilot. Tweak the settings, send a prompt, and I'll answer right away."
};

const createMessage = (role, content, extra = {}) => ({
  id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  ...extra
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function App() {
  const [settings, setSettings] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('settings') || '{}');
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch (error) {
      console.warn('Unable to parse settings from storage', error);
      return { ...DEFAULT_SETTINGS };
    }
  });

  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const scrollerRef = useRef(null);
  const controllerRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef(null);

  const statusLabel = isSending ? 'Thinking...' : 'Ready';

  const showToast = useCallback((message, tone = 'info') => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  const persistSettings = useCallback((next) => {
    setSettings(next);
    localStorage.setItem('settings', JSON.stringify(next));
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const threshold = 160;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    stickToBottomRef.current = nearBottom;
    setIsNearBottom(nearBottom);
  }, []);

  const scrollToLatest = useCallback((behavior = 'smooth') => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToLatest(messages.length <= 2 ? 'instant' : 'smooth');
    }
  }, [messages, scrollToLatest]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === 'error' ? 3600 : 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (settingsOpen) {
      document.body.classList.add('drawer-open');
    } else {
      document.body.classList.remove('drawer-open');
    }
    return () => document.body.classList.remove('drawer-open');
  }, [settingsOpen]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  const abortGeneration = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
    }
  }, []);

  const resetConversation = useCallback(async () => {
    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (error) {
      console.warn('Reset request failed', error);
    }
    setMessages([WELCOME_MESSAGE]);
    showToast('Conversation cleared', 'info');
    setIsNearBottom(true);
    stickToBottomRef.current = true;
  }, [showToast]);

  const normaliseSettings = useCallback((draft) => {
    const draftMaxTokens = draft.maxTokens != null ? String(draft.maxTokens) : '';
    const trimmedMaxTokens = draftMaxTokens.trim();
    let parsedMaxTokens = '';
    if (trimmedMaxTokens !== '') {
      const numeric = Number.parseInt(trimmedMaxTokens, 10);
      if (Number.isFinite(numeric) && numeric > 0) {
        parsedMaxTokens = String(numeric);
      }
    }
    return {
      baseUrl: draft.baseUrl.trim(),
      modelId: draft.modelId.trim(),
      apiKey: (draft.apiKey || 'lm-studio').trim() || 'lm-studio',
      systemPrompt: draft.systemPrompt || '',
      temperature: clamp(Number(draft.temperature) || 0.7, 0, 1.5),
      maxTokens: parsedMaxTokens
    };
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isSending) {
      return;
    }

    if (!settings.baseUrl || !settings.modelId) {
      showToast('Please configure Base URL and Model ID first.', 'error');
      return;
    }

    const userMessage = createMessage('user', text);
    const assistantPlaceholder = createMessage('assistant', '', { pending: true });

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    setInput('');
    setIsSending(true);
    stickToBottomRef.current = true;

    const controller = new AbortController();
    controllerRef.current = controller;

    const maxTokenValue = settings.maxTokens ? Number.parseInt(settings.maxTokens, 10) : null;
    const payload = {
      message: text,
      base_url: settings.baseUrl,
      api_key: settings.apiKey || 'lm-studio',
      model: settings.modelId,
      system_prompt: settings.systemPrompt,
      temperature: Number(settings.temperature) || 0.7,
      max_tokens: Number.isFinite(maxTokenValue) && maxTokenValue > 0 ? maxTokenValue : null,
      reset: false
    };

    if (payload.max_tokens === null) {
      delete payload.max_tokens;
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const reply = (data.reply || '').trim() || '…';

      setMessages((prev) => prev.map((msg) => (
        msg.id === assistantPlaceholder.id
          ? { ...msg, pending: false, content: reply }
          : msg
      )));

      showToast('Response ready', 'success');
    } catch (error) {
      if (error.name === 'AbortError') {
        setMessages((prev) => prev.filter((msg) => msg.id !== assistantPlaceholder.id));
        showToast('Generation cancelled', 'info');
      } else {
        const errorMessage = error.message || 'Request failed';
        setMessages((prev) => prev.map((msg) => (
          msg.id === assistantPlaceholder.id
            ? { ...msg, pending: false, error: true, content: `[Error] ${errorMessage}` }
            : msg
        )));
        showToast(errorMessage, 'error');
      }
    } finally {
      controllerRef.current = null;
      setIsSending(false);
    }
  }, [input, isSending, settings, showToast]);

  const handleSaveSettings = useCallback((draft) => {
    const clean = normaliseSettings(draft);
    persistSettings(clean);
    showToast('Settings saved', 'success');
  }, [normaliseSettings, persistSettings, showToast]);

  const handleRestoreDefaults = useCallback(() => {
    const clean = { ...DEFAULT_SETTINGS };
    persistSettings(clean);
    showToast('Defaults restored', 'info');
  }, [persistSettings, showToast]);

  const computedBaseInfo = useMemo(() => ({
    baseUrl: settings.baseUrl,
    modelId: settings.modelId
  }), [settings.baseUrl, settings.modelId]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950">
      <BackgroundDecor />
      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-10 sm:px-8">
        <header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/20 text-lg font-semibold text-indigo-300 shadow-inner shadow-indigo-500/20">
              LLM
            </span>
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-white">Local LLM Chat</h1>
              <p className="mt-1 text-sm text-slate-400">A private assistant streamed from your own runtime. Tailor the prompt, send a message, and iterate quickly.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill label={statusLabel} busy={isSending} />
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9" /><path d="M3 12a9 9 0 0 0 9 9" /><path d="M8 12a4 4 0 0 0 4 4" /><path d="M16 12a4 4 0 0 0-4-4" /></svg>
              Configure
            </button>
          </div>
        </header>

        <main className="mt-10 flex flex-1 flex-col gap-6">
          <section
            ref={scrollerRef}
            onScroll={handleScroll}
            className="relative flex-1 overflow-y-auto rounded-3xl border border-white/5 bg-slate-900/60 p-6 shadow-2xl shadow-black/30 backdrop-blur"
          >
            <div className="flex flex-col gap-6">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </div>
            <div className="pointer-events-none sticky bottom-0 h-8 bg-gradient-to-t from-slate-900/90 to-transparent" aria-hidden />
          </section>

          <Composer
            input={input}
            setInput={setInput}
            isSending={isSending}
            onSend={sendMessage}
            onAbort={abortGeneration}
            textareaRef={textareaRef}
          />
        </main>

        <footer className="mt-8 grid gap-2 text-sm text-slate-500 sm:flex sm:items-center sm:justify-between">
          <span className="font-medium text-slate-400">Endpoint</span>
          <div className="flex flex-wrap gap-2 text-slate-500">
            <span className="rounded-full border border-white/5 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">{computedBaseInfo.modelId || 'model not set'}</span>
            <span className="rounded-full border border-white/5 bg-white/5 px-3 py-1 text-xs font-medium text-slate-400">{computedBaseInfo.baseUrl || 'base URL not set'}</span>
          </div>
        </footer>
      </div>

      <ScrollToLatestButton visible={!isNearBottom} onClick={() => { stickToBottomRef.current = true; setIsNearBottom(true); scrollToLatest(); }} />

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={(draft) => { handleSaveSettings(draft); setSettingsOpen(false); }}
        onResetConversation={() => { resetConversation(); setSettingsOpen(false); }}
        onRestoreDefaults={() => { handleRestoreDefaults(); setSettingsOpen(false); }}
        initialSettings={settings}
        isBusy={isSending}
      />

      {toast && <Toast toast={toast} />}
    </div>
  );
}

function BackgroundDecor() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-36 top-0 h-72 w-72 rounded-full bg-indigo-500/30 blur-3xl sm:h-80 sm:w-80" />
      <div className="absolute right-[-20%] top-12 h-80 w-80 rounded-full bg-emerald-400/20 blur-3xl sm:h-96 sm:w-96" />
      <div className="absolute left-1/2 top-1/2 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-purple-500/10 blur-[140px]" />
    </div>
  );
}

function StatusPill({ label, busy }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-sm ${busy ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-100' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${busy ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-400'}`} />
      {label}
    </span>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`fade-in-up flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[680px] rounded-3xl border px-5 py-4 shadow-glow ${isUser ? 'border-indigo-500/40 bg-indigo-500 text-white' : 'border-white/5 bg-slate-900/80 text-slate-100'}`}>
        <div className="mb-2 flex items-center gap-3 text-xs uppercase tracking-wide text-white/60">
          <span className={`flex h-8 w-8 items-center justify-center rounded-full ${isUser ? 'bg-white/20 text-white' : 'bg-white/10 text-white/90'}`}>
            {isUser ? 'You' : 'LLM'}
          </span>
          <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        {message.pending ? (
          <span className="flex items-center gap-2 text-white/70">
            <span className="h-2 w-2 animate-bounce rounded-full bg-white/70"></span>
            <span className="h-2 w-2 animate-bounce rounded-full bg-white/70" style={{ animationDelay: '120ms' }}></span>
            <span className="h-2 w-2 animate-bounce rounded-full bg-white/70" style={{ animationDelay: '240ms' }}></span>
            <span className="text-xs uppercase tracking-[0.2em] text-white/50">Generating</span>
          </span>
        ) : (
          <p className={`whitespace-pre-wrap leading-relaxed ${message.error ? 'text-red-300' : 'text-inherit'}`}>
            {message.content}
          </p>
        )}
      </div>
    </div>
  );
}

function Composer({ input, setInput, isSending, onSend, onAbort, textareaRef }) {
  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  }, [onSend]);

  return (
    <div className="rounded-3xl border border-white/5 bg-slate-900/80 p-4 shadow-2xl shadow-black/30 backdrop-blur">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question or describe what you need..."
            spellCheck="true"
            rows={1}
            disabled={isSending}
            className="min-h-[56px] max-h-40 w-full resize-none overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
            <span>Press <kbd className="rounded border border-white/10 bg-white/5 px-1">Enter</kbd> to send · <kbd className="rounded border border-white/10 bg-white/5 px-1">Shift</kbd> + <kbd className="rounded border border-white/10 bg-white/5 px-1">Enter</kbd> for newline</span>
            <span>{input.trim().length} chars</span>
          </div>
        </div>
        <div className="flex items-center gap-3 self-end">
          <button
            type="button"
            onClick={onAbort}
            disabled={!isSending}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:border-white/5 disabled:text-slate-600"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
            Stop
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={isSending || !input.trim()}
            className="inline-flex items-center gap-2 rounded-full bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:-translate-y-0.5 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:bg-indigo-500/40 disabled:text-indigo-100/60"
          >
            {isSending ? (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 animate-bounce rounded-full bg-white"></span>
                <span className="h-2 w-2 animate-bounce rounded-full bg-white" style={{ animationDelay: '120ms' }}></span>
                <span className="h-2 w-2 animate-bounce rounded-full bg-white" style={{ animationDelay: '240ms' }}></span>
                <span>Sending...</span>
              </span>
            ) : (
              <>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m4 4 16 8-16 8 4-8-4-8z" /></svg>
                Send
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsDrawer({ open, onClose, onSave, onResetConversation, onRestoreDefaults, initialSettings, isBusy }) {
  const [draft, setDraft] = useState(initialSettings);

  useEffect(() => {
    if (open) {
      setDraft(initialSettings);
    }
  }, [open, initialSettings]);

  if (!open) {
    return null;
  }

  const updateDraft = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    onSave(draft);
  };

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l border-white/10 bg-slate-900/95 px-6 py-8 shadow-2xl sm:px-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-semibold text-white">Conversation setup</h2>
            <p className="mt-1 text-sm text-slate-400">Define how the assistant connects to your local runtime.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-white/10 p-2 text-slate-300 transition hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70" aria-label="Close settings">
            <svg className="h-4 w-4" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Base URL</label>
            <input
              value={draft.baseUrl}
              onChange={(event) => updateDraft('baseUrl', event.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/30"
              placeholder="https://your-endpoint/v1"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Model ID</label>
            <input
              value={draft.modelId}
              onChange={(event) => updateDraft('modelId', event.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/30"
              placeholder="provider/model"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">API Key</label>
            <input
              value={draft.apiKey}
              onChange={(event) => updateDraft('apiKey', event.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/30"
              placeholder="lm-studio"
            />
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">
              <span>Temperature</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300">{Number(draft.temperature).toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={draft.temperature}
              onChange={(event) => updateDraft('temperature', Number(event.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Max tokens <span className="text-slate-500">(optional)</span></label>
            <input
              value={draft.maxTokens}
              onChange={(event) => updateDraft('maxTokens', event.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/30"
              placeholder="Leave blank for model default"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">System prompt</label>
            <textarea
              value={draft.systemPrompt}
              onChange={(event) => updateDraft('systemPrompt', event.target.value)}
              rows={5}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/30"
              placeholder="Add guardrails or behavior guidelines for the assistant"
            />
          </div>
          <div className="drawer-actions">
            <button
              type="button"
              onClick={onRestoreDefaults}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
            >
              Restore defaults
            </button>
            <div className="drawer-actions__cta">
              <button
                type="button"
                onClick={onResetConversation}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
              >
                Clear chat
              </button>
              <button
                type="submit"
                disabled={isBusy}
                className="inline-flex items-center gap-2 rounded-full bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:-translate-y-0.5 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:bg-indigo-500/40"
              >
                Save & close
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function ScrollToLatestButton({ visible, onClick }) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-indigo-500/90 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/40 backdrop-blur transition hover:-translate-y-0.5 hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 9 6 6 6-6" /></svg>
      Latest
    </button>
  );
}

function Toast({ toast }) {
  const tone = toast.tone === 'error'
    ? 'border-red-500/40 bg-red-500/10 text-red-100'
    : toast.tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
      : 'border-white/10 bg-white/10 text-slate-100';

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 transform px-4">
      <div className={`pointer-events-auto rounded-2xl border px-4 py-3 text-sm shadow-xl backdrop-blur ${tone}`}>
        {toast.message}
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}
if (ReactDOM.createRoot) {
  ReactDOM.createRoot(rootElement).render(<App />);
} else if (ReactDOM.render) {
  ReactDOM.render(<App />, rootElement);
} else {
  throw new Error('No compatible React renderer found');
}


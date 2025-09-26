# Local LLM Chat (Flask + vanilla JS)

A complete chat UI that proxies to an OpenAI-compatible endpoint (LM Studio running behind Cloudflare quick tunnel).

## Run
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export FLASK_SECRET_KEY="dev-key"  # set your own
python app.py
# open http://127.0.0.1:5000
```

## Configure
- In the left settings panel:
  - Base URL: your Cloudflare quick tunnel URL with `/v1` suffix, e.g.
    `https://mainland-guitars-treating-anymore.trycloudflare.com/v1`
  - Model ID: whatever LM Studio exposes (e.g. `qwen/qwen3-30b-a3b-2507`)
  - API Key: any string (LM Studio ignores it)
  - System prompt, temperature, max tokens
- Click **Save Settings**. They persist in localStorage.

## Features
- Streaming responses via SSE-style stream
- New chat (server and UI history cleared)
- Copy to clipboard per message
- Mobile-friendly layout, subtle animations
- No external JS frameworks

## Notes
- This server holds chat history per browser session (Flask signed cookie). For multi-user persistence, back it with a DB.
- If your tunnel changes, update Base URL in settings.
- If LM Studio returns `model not found`, verify the exact model id shown in LM Studio.

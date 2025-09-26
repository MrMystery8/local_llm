import os
from datetime import timedelta
from time import perf_counter
from typing import Iterable, List, Optional, Union

from flask import Flask, jsonify, render_template, request, session
from openai import OpenAI

# ----- Config -----
DEFAULT_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://mainland-guitars-treating-anymore.trycloudflare.com/v1")
DEFAULT_API_KEY = os.getenv("OPENAI_API_KEY", "lm-studio")  # LM Studio ignores token, but client requires a string
DEFAULT_MODEL = os.getenv("MODEL_ID", "qwen/qwen3-30b-a3b-2507")

def is_vision_model(model_id: str) -> bool:
    if not model_id:
        return False
    return "magistral" in str(model_id).lower()


app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-this-key")
app.permanent_session_lifetime = timedelta(days=1)


def sanitize_message_content(content):
    if isinstance(content, list):
        sanitized = []
        for item in content:
            if not isinstance(item, dict):
                sanitized.append(item)
                continue
            item_type = item.get("type")
            if item_type == "image_url":
                sanitized.append({"type": "text", "text": "[Image attachment omitted from history]"})
            else:
                sanitized.append(item)
        return sanitized
    return content


def get_history():
    history = session.get("history")
    if not history:
        session["history"] = []
        return session["history"]

    cleaned = []
    mutated = False
    for entry in history:
        if not isinstance(entry, dict):
            mutated = True
            continue
        role = entry.get("role")
        content = entry.get("content")
        sanitized = sanitize_message_content(content)
        if sanitized != content:
            mutated = True
        cleaned.append({"role": role, "content": sanitized})

    if mutated:
        session["history"] = cleaned
        return session["history"]
    return history


def add_message(role, content):
    history = get_history()
    history.append({"role": role, "content": sanitize_message_content(content)})
    session["history"] = history


def _usage_to_dict(usage) -> Optional[dict]:
    if not usage:
        return None

    data = None
    if hasattr(usage, "model_dump"):
        data = usage.model_dump()
    elif isinstance(usage, dict):
        data = usage
    else:
        data = {
            "prompt_tokens": getattr(usage, "prompt_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None),
        }

    cleaned = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = None
        if isinstance(data, dict):
            value = data.get(key)
        if value is None:
            continue
        try:
            cleaned[key] = int(value)
        except (TypeError, ValueError):
            continue

    return cleaned or None


def _update_session_usage(usage_dict: Optional[dict]) -> Optional[dict]:
    if not usage_dict:
        return None

    totals = session.get("usage_totals") or {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
    }

    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage_dict.get(key)
        if value is None:
            continue
        totals[key] = int(totals.get(key, 0)) + int(value)

    session["usage_totals"] = totals
    return totals


@app.route("/")
def index():
    return render_template("index.html", default_base_url=DEFAULT_BASE_URL, default_model=DEFAULT_MODEL)


@app.route("/api/reset", methods=["POST"])
def reset_chat():
    session["history"] = []
    session.pop("usage_totals", None)
    return jsonify({"ok": True})


def _normalize_model_list(payload: Union[dict, Iterable]):
    def to_pair(item):
        model_id = getattr(item, "id", None)
        owned_by = getattr(item, "owned_by", None)
        if model_id is None and isinstance(item, dict):
            model_id = item.get("id") or item.get("model")
            owned_by = owned_by or item.get("owned_by")
        return model_id, owned_by

    data: Iterable = []
    if hasattr(payload, "data"):
        data = getattr(payload, "data") or []
    elif isinstance(payload, dict):
        if "data" in payload:
            data = payload.get("data") or []
        elif "models" in payload:
            data = payload.get("models") or []
        else:
            data = payload.values()
    elif isinstance(payload, Iterable):
        data = payload

    models: List[dict] = []
    for item in data:
        model_id, owned_by = to_pair(item)
        if model_id:
            models.append({"id": model_id, "owned_by": owned_by})

    models.sort(key=lambda m: m["id"])
    return models


@app.route("/api/models", methods=["GET"])
def list_models():
    base_url = request.args.get("base_url") or DEFAULT_BASE_URL
    api_key = request.args.get("api_key") or DEFAULT_API_KEY

    client = OpenAI(base_url=base_url, api_key=api_key)
    try:
        response = client.models.list()
    except Exception as exc:  # pragma: no cover - external dependency
        return jsonify({"error": str(exc)}), 502

    models = _normalize_model_list(response)
    return jsonify({"models": models})


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    user_msg = data.get("message", "").strip()
    if not user_msg:
        return jsonify({"error": "Empty message"}), 400

    # Settings from client
    base_url = data.get("base_url") or DEFAULT_BASE_URL
    api_key = data.get("api_key") or DEFAULT_API_KEY
    model = data.get("model") or DEFAULT_MODEL
    raw_image = data.get("image_data")
    image_data = raw_image.strip() if isinstance(raw_image, str) else None
    image_name = data.get("image_name")
    image_type = data.get("image_type")
    raw_detail = data.get("image_detail")
    image_detail = None
    if isinstance(raw_detail, str):
        cleaned_detail = raw_detail.strip().lower()
        if cleaned_detail in {"low", "auto", "high"}:
            image_detail = cleaned_detail
    if image_data and not is_vision_model(model):
        image_data = None
        image_detail = None
    if image_data and image_detail is None:
        image_detail = "high"
    system_prompt = data.get("system_prompt") or ""
    temperature = float(data.get("temperature") or 0.7)
    max_tokens = data.get("max_tokens")
    if max_tokens in ("", None):
        max_tokens = None
    else:
        try:
            max_tokens = int(max_tokens)
            if max_tokens <= 0:
                max_tokens = None
        except Exception:
            max_tokens = None

    if data.get("reset"):
        session["history"] = []

    # Build messages: optional system, then history, then new user
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for item in get_history():
        messages.append(item)

    user_content = user_msg
    if image_data:
        parts = []
        if user_msg:
            parts.append({"type": "text", "text": user_msg})
        image_payload = {"url": image_data}
        if image_detail:
            image_payload["detail"] = image_detail
        parts.append({"type": "image_url", "image_url": image_payload})
        user_content = parts

    messages.append({"role": "user", "content": user_content})

    # Persist user message to history early
    add_message("user", user_content)

    client = OpenAI(base_url=base_url, api_key=api_key)

    try:
        kwargs = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens

        start_time = perf_counter()
        completion = client.chat.completions.create(**kwargs)
        latency_ms = int((perf_counter() - start_time) * 1000)
        choice = completion.choices[0] if completion.choices else None
        assistant_text = ""
        if choice is not None:
            message = getattr(choice, "message", None)
            if message is not None:
                assistant_text = getattr(message, "content", "") or ""
        add_message("assistant", assistant_text)
        usage = _usage_to_dict(getattr(completion, "usage", None))
        session_totals = _update_session_usage(usage)
        payload = {
            "reply": assistant_text,
            "latency_ms": latency_ms,
            "usage": usage or {},
        }
        if session_totals:
            payload["session_totals"] = session_totals
        return jsonify(payload)
    except Exception as exc:  # pragma: no cover - external dependency
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)


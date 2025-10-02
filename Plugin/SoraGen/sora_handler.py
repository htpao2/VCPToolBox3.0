import sys
import json
import os
import requests
import threading
import uuid
from datetime import datetime
import traceback
from dotenv import load_dotenv

# --- Configuration and Constants ---
LOG_FILE = "SoraGen.log"
DZZ_API_URL = "https://api.dzz.ai/v1/chat/completions"
PLUGIN_NAME_FOR_CALLBACK = "SoraGen"

# --- Logging ---
def log_event(level, message, data=None):
    """Logs an event to the log file."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] [{level.upper()}] {message}"
    if data:
        try:
            log_entry += f" | Data: {json.dumps(data, ensure_ascii=False)}"
        except Exception:
            log_entry += " | Data: [Unserializable Data]"
    try:
        # Ensure the log file is in the same directory as the script
        log_path = os.path.join(os.path.dirname(__file__), LOG_FILE)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(log_entry + "\n")
    except Exception as e:
        print(f"Error writing to log file: {e}", file=sys.stderr)

# --- JSON Output ---
def print_json_output(status, result=None, error=None):
    """Prints a standardized JSON object to stdout."""
    output = {"status": status}
    if result is not None:
        output["result"] = result
    if error is not None:
        output["error"] = error
    print(json.dumps(output, ensure_ascii=False))
    log_event("debug", "Output sent to stdout", output)

# --- Background Stream Handling and Callback ---
def handle_stream_and_callback(api_key, prompt, request_id, callback_base_url):
    """
    Handles the streaming API request in a background thread and sends a callback
    when the task is complete.
    """
    log_event("info", f"[{request_id}] Starting background stream handler.", {
        "request_id": request_id,
        "callback_base_url": callback_base_url
    })

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "model": "sora_video2",
        "stream": True
    }

    final_content = ""
    error_message = None

    try:
        with requests.post(DZZ_API_URL, json=payload, headers=headers, stream=True, timeout=1800) as response:
            response.raise_for_status()
            log_event("info", f"[{request_id}] Connected to streaming API.")

            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8')
                    if decoded_line.startswith('data: '):
                        json_str = decoded_line[len('data: '):]
                        if json_str == '[DONE]':
                            log_event("info", f"[{request_id}] Stream finished.")
                            break
                        try:
                            data = json.loads(json_str)
                            content = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if content:
                                final_content += content
                        except json.JSONDecodeError:
                            log_event("warning", f"[{request_id}] Could not decode JSON from stream line: {json_str}")

    except requests.exceptions.RequestException as e:
        log_event("error", f"[{request_id}] API request failed.", {"error": str(e)})
        error_message = f"API request failed: {e}"
    except Exception as e:
        log_event("critical", f"[{request_id}] Unexpected error during stream handling.", {"error": str(e), "traceback": traceback.format_exc()})
        error_message = f"An unexpected error occurred: {e}"

    # --- Perform Callback ---
    callback_url = f"{callback_base_url}/{PLUGIN_NAME_FOR_CALLBACK}/{request_id}"
    callback_payload = {
        "requestId": request_id,
        "pluginName": PLUGIN_NAME_FOR_CALLBACK
    }

    if error_message:
        callback_payload["status"] = "Failed"
        callback_payload["reason"] = error_message
        callback_payload["message"] = f"视频 (ID: {request_id}) 生成失败。原因: {error_message}"
    elif final_content:
        # Assuming the final content is the video URL or contains it.
        # This part might need adjustment based on the actual API response format.
        video_url = final_content.strip()
        callback_payload["status"] = "Succeed"
        callback_payload["videoUrl"] = video_url
        callback_payload["message"] = f"视频 (ID: {request_id}) 生成成功！URL: {video_url}"
    else:
        callback_payload["status"] = "Failed"
        callback_payload["reason"] = "No content received from stream."
        callback_payload["message"] = f"视频 (ID: {request_id}) 生成失败。原因: 未从API接收到有效内容。"

    log_event("info", f"[{request_id}] Attempting callback to {callback_url}", {"payload": callback_payload})

    try:
        callback_response = requests.post(callback_url, json=callback_payload, timeout=30)
        callback_response.raise_for_status()
        log_event("success", f"[{request_id}] Callback successful.", {"status_code": callback_response.status_code})
    except requests.exceptions.RequestException as e:
        log_event("error", f"[{request_id}] Callback failed.", {"error": str(e)})

# --- Main Logic ---
def main():
    # Load config from .env file in the same directory
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)

    api_key = os.getenv("DZZ_API_KEY")
    callback_base_url_env = os.getenv("CALLBACK_BASE_URL")

    if not api_key:
        print_json_output("error", error="DZZ_API_KEY not found in environment variables.")
        sys.exit(1)
    if not callback_base_url_env:
        log_event("warning", "CALLBACK_BASE_URL not found. Callback will fail.")

    try:
        input_str = sys.stdin.read()
        input_data = json.loads(input_str)
        log_event("debug", "Parsed input data", input_data)
    except (json.JSONDecodeError, Exception) as e:
        log_event("error", "Failed to read or parse stdin.", {"error": str(e)})
        print_json_output("error", error=f"Invalid input: {e}")
        sys.exit(1)

    command = input_data.get("command")
    prompt = input_data.get("prompt")

    try:
        if command == "submit":
            if not prompt:
                raise ValueError("缺少必需的 'prompt' 参数。")

            request_id = str(uuid.uuid4())

            # Start background thread
            thread = threading.Thread(
                target=handle_stream_and_callback,
                args=(api_key, prompt, request_id, callback_base_url_env)
            )
            thread.start()
            log_event("info", f"[{request_id}] Background thread started for prompt: {prompt}")

            # Immediately return the placeholder to the AI
            result_string_for_ai = (
                f"Sora视频生成任务 (ID: {request_id}) 已成功提交。\n"
                f"这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n"
                f"请在你的回复中包含以下占位符原文：{{{{VCP_ASYNC_RESULT::SoraGen::{request_id}}}}}"
            )
            print_json_output(status="success", result=result_string_for_ai)

        else:
            raise ValueError(f"无效的 'command' 参数: {command}。必须是 'submit'。")

    except ValueError as e:
        log_event("error", f"Command processing failed: {command}", {"error": str(e)})
        print_json_output("error", error=str(e))
        sys.exit(1)
    except Exception as e:
        log_event("critical", "Unexpected error in main logic", {"error": str(e), "traceback": traceback.format_exc()})
        print_json_output("error", error=f"发生意外错误: {e}")
        sys.exit(2)

if __name__ == "__main__":
    main()
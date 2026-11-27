import sys
import json
import os
import subprocess
import threading
import requests
import uuid
import time
import shlex
from datetime import datetime
from dotenv import load_dotenv

# Load environment variables
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
dotenv_path = os.path.join(BASE_DIR, 'config.env')
load_dotenv(dotenv_path=dotenv_path)

CALLBACK_BASE_URL = os.getenv("CALLBACK_BASE_URL", "http://localhost:3000")
PLUGIN_NAME = "AgentCLIExecutor"
PROFILES_FILE = os.path.join(BASE_DIR, 'agent_profiles.json')

# --- Helper Functions ---

def log_event(level, message, data=None):
    """Simple file-based logging for debugging."""
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_entry = f"[{timestamp}] [{level.upper()}] {message}"
        if data:
            log_entry += f" | Data: {json.dumps(data, ensure_ascii=False)}"

        with open("agent_executor.log", "a", encoding="utf-8") as f:
            f.write(log_entry + "\n")
    except Exception:
        pass # Don't crash on logging

def load_profiles():
    try:
        with open(PROFILES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f).get('profiles', {})
    except Exception as e:
        log_event("error", f"Failed to load profiles: {e}")
        return {}

def resolve_argument(arg_template, context):
    """
    Replace placeholders in arguments.
    Supported: {instruction}, {env.VAR_NAME}
    """
    val = arg_template
    # Replace instruction
    if "{instruction}" in val:
        val = val.replace("{instruction}", context.get("instruction", ""))

    # Replace env vars
    if "{env." in val:
        import re
        def replace_env(match):
            var_name = match.group(1)
            return os.getenv(var_name, "")
        val = re.sub(r'\{env\.([A-Za-z0-9_]+)\}', replace_env, val)

    return val

# --- Background Task ---

def run_agent_background(task_id, profile, instruction, extra_args):
    log_event("info", f"[{task_id}] Background task started", {"agent": profile['description']})

    result_status = "Failed"
    result_output = ""
    start_time = time.time()

    try:
        # 1. Prepare Command
        cmd_template = profile.get("command_template", [])
        if not cmd_template:
            raise ValueError("Profile missing 'command_template'")

        # Resolve command arguments
        final_cmd = [resolve_argument(arg, {"instruction": instruction}) for arg in cmd_template]

        # Append extra args if any
        if extra_args:
             # Use shlex to handle quoted arguments correctly
             final_cmd.extend(shlex.split(extra_args))

        # 2. Prepare Environment
        env = os.environ.copy()
        # (Optional: Inject specific env vars from config if needed)

        # 3. Execution
        input_mode = profile.get("input_mode", "args")
        stdin_input = None

        if input_mode == "stdin":
            stdin_input = instruction

        timeout = profile.get("timeout", 600)

        log_event("debug", f"[{task_id}] Executing command", {"cmd": final_cmd, "input_mode": input_mode})

        process_result = subprocess.run(
            final_cmd,
            input=stdin_input,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=BASE_DIR # Run in plugin dir by default
        )

        # 4. Result Handling
        stdout = process_result.stdout
        stderr = process_result.stderr
        exit_code = process_result.returncode

        if exit_code == 0:
            result_status = "Succeed"
            result_output = stdout
        else:
            result_status = "Failed"
            result_output = f"Exit Code: {exit_code}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"

    except subprocess.TimeoutExpired:
        result_status = "Failed"
        result_output = f"Execution timed out after {timeout} seconds."
    except Exception as e:
        result_status = "Failed"
        result_output = f"Execution error: {str(e)}"

    duration = time.time() - start_time
    log_event("info", f"[{task_id}] Task finished", {
        "status": result_status,
        "duration": duration,
        "output_preview": result_output[:200]
    })

    # 5. Callback
    callback_url = f"{CALLBACK_BASE_URL}/{PLUGIN_NAME}/{task_id}"
    payload = {
        "requestId": task_id,
        "status": result_status,
        "result": result_output, # Standard field for VCP async result
        # Extra fields for UI if needed
        "message": f"Agent execution {result_status}. Duration: {duration:.2f}s",
        "details": result_output
    }

    try:
        requests.post(callback_url, json=payload, timeout=10)
        log_event("info", f"[{task_id}] Callback sent successfully")
    except Exception as e:
        log_event("error", f"[{task_id}] Callback failed: {e}")


# --- Main Handler ---

def main():
    try:
        # Read input from stdin
        input_str = sys.stdin.read()
        if not input_str.strip():
             # Fallback for empty input (prevent crash)
             print(json.dumps({"status": "error", "error": "No input received"}))
             return

        args = json.loads(input_str)

        command = args.get("command_name") or args.get("tool_name") # VCP sometimes passes tool_name
        # Note: VCP usually passes the raw args object.
        # Check specific params

        agent_name = args.get("agent_name")
        action = args.get("command") # commandIdentifier often mapped here if multiple commands

        # Dispatch: List Agents
        if action == "list_agents" or args.get("commandIdentifier") == "list_agents":
            profiles = load_profiles()
            agent_list = [
                {"name": k, "description": v.get("description")}
                for k, v in profiles.items()
            ]
            print(json.dumps({
                "status": "success",
                "result": {
                    "agents": agent_list,
                    "message": f"Found {len(agent_list)} available agents."
                }
            }))
            return

        # Dispatch: Execute Agent
        if agent_name:
            profiles = load_profiles()
            profile = profiles.get(agent_name)

            if not profile:
                print(json.dumps({
                    "status": "error",
                    "error": f"Agent profile '{agent_name}' not found. Available: {list(profiles.keys())}"
                }))
                return

            instruction = args.get("instruction", "")
            extra_args = args.get("extra_args", "")

            # Generate ID
            task_id = str(uuid.uuid4())

            # Start Background Thread
            t = threading.Thread(
                target=run_agent_background,
                args=(task_id, profile, instruction, extra_args)
            )
            t.daemon = True # Allow main process to exit?
            # Wait, VCP Python plugins:
            # VideoGenerator uses t.start() but does NOT join, AND does not exit main?
            # VideoGenerator.py -> main() -> prints json -> exits?
            # No, VideoGenerator.py:
            # "polling_thread.start() ... log_event... return request_id"
            # It seems the python script stays alive?
            # Re-reading Sync/Async manual:
            # "VideoGenerator... immediately prints to stdout... process *does not exit*, but starts background thread..."
            # WAIT. If main() returns/exits, the process dies and the thread dies (if non-daemon) or is killed?
            # VideoGenerator manual says: "video_handler.py process *does not exit*... starts background thread... The background thread starts polling..."

            # Implementation detail in VideoGenerator.py:
            # It actually DOES exit main().
            # "polling_thread = threading.Thread(...); polling_thread.start()"
            # If the script exits, the thread dies if it is daemon. If it is NOT daemon, Python waits for it.
            # VideoGenerator logic: "must be non-daemon thread (default is non-daemon), so main process waits for it."

            t.daemon = False
            t.start()

            # Construct Placeholder Response
            placeholder = f"{{{{VCP_ASYNC_RESULT::{PLUGIN_NAME}::{task_id}}}}}"

            print(json.dumps({
                "status": "success",
                "result": f"Agent '{agent_name}' started. Task ID: {task_id}.\n{placeholder}"
            }))

            # We must NOT exit immediately if we rely on the thread running in this process.
            # But we MUST close stdout so VCP knows we are "done" with the synchronous part?
            # Sync/Async manual says: "Plugin process prints to stdout... Main service reads stdout... plugin process finished its mission, can exit." -> This is for SYNC plugins.
            # For ASYNC: "Plugin process prints placeholder... Main service reads it... "
            # Does VCP kill the process after reading stdout?
            # Manual: "Main service reads stdout... plugin process completed its mission...".
            # If VCP kills the process, the thread dies.

            # Re-read manual section 5.3:
            # "video_handler.py ... immediately prints to stdout... *Do not exit process!*"
            # Wait, "video_handler.py process *does not exit*"
            # But later: "polling_thread... must be non-daemon... so main process waits for it."
            # This implies the main thread reaches end of script, but Python interpreter stays alive because of non-daemon thread.
            # Does VCP Server *wait* for the process to exit?
            # If VCP Server uses `spawn`, and reads stdout. If it keeps the process object, it's fine.
            # If VCP Server calls `child.kill()` after getting JSON, we are doomed.

            # Let's check `VideoGenerator/plugin-manifest.json` again.
            # "pluginType": "asynchronous"
            # This tells VCP "Do NOT kill me immediately, or do not expect me to exit immediately?"
            # Actually, `Plugin.js` logic for async might just be: Read stdout, check for valid JSON. If valid, process it.
            # If the process stays alive, fine.

            # The manual says: "Plugin process ... immediately prints to stdout ... Do not exit process!"
            # So I should ensure the script doesn't explicitly `sys.exit()` until the thread is done,
            # OR just rely on Python's default behavior (wait for non-daemon threads).
            # But I must ensure stdout is flushed so VCP sees the response.
            sys.stdout.flush()

            # The thread is running. Main thread ends. Python waits for thread.
            # Process stays alive. VCP sees JSON on stdout.
            # VCP consumes stdout. Does VCP close stdin?

            return

        # Fallback
        print(json.dumps({
            "status": "error",
            "error": "Invalid arguments. Provide 'agent_name' and 'instruction' or use 'list_agents'."
        }))

    except Exception as e:
        log_event("critical", f"Handler crash: {e}")
        print(json.dumps({"status": "error", "error": str(e)}))

if __name__ == "__main__":
    main()

import sys
import json
import os
import threading
import time
import requests
import asyncio
from video_processor import VideoProcessor
from dotenv import load_dotenv

# Load config
load_dotenv("config.env")

CALLBACK_BASE_URL = os.getenv("CALLBACK_BASE_URL")
PLUGIN_NAME_FOR_CALLBACK = os.getenv("PLUGIN_NAME_FOR_CALLBACK", "AICapCut")

# Fix: Initialize processor with config values
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "./output")
TEMP_DIR = os.getenv("TEMP_DIR", "./temp")

# Ensure absolute paths if needed, but relative usually works in VCP plugin context
processor = VideoProcessor(output_dir=OUTPUT_DIR, temp_dir=TEMP_DIR)

def handle_async_task(task_id, command, args):
    """
    Executes the task in background and sends callback.
    """
    result_data = {"status": "failed", "error": "Unknown error"}

    try:
        if command == "render_timeline":
            timeline = args.get("timeline")
            if isinstance(timeline, str):
                try:
                    timeline = json.loads(timeline)
                except:
                    pass

            output_path = processor.render_timeline(timeline, output_filename=f"{task_id}.mp4")

            abs_path = os.path.abspath(output_path)

            result_data = {
                "status": "success",
                "video_path": abs_path,
                "message": "Video rendered successfully."
            }

        elif command == "script_to_video":
            script = args.get("script")
            voice = args.get("voice", "en-US-AnaNeural")
            bg_images = args.get("background_images", [])

            # Create a new event loop for async logic (edge-tts) in this thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            output_path = loop.run_until_complete(
                processor.generate_script_video(script, voice, bg_images)
            )
            loop.close()

            abs_path = os.path.abspath(output_path)

            result_data = {
                "status": "success",
                "video_path": abs_path,
                "message": "Script-to-video generated successfully."
            }

    except Exception as e:
        import traceback
        traceback.print_exc()
        result_data = {
            "status": "failed",
            "error": str(e)
        }

    # Send Callback
    if CALLBACK_BASE_URL:
        callback_url = f"{CALLBACK_BASE_URL}/{PLUGIN_NAME_FOR_CALLBACK}/{task_id}"
        try:
            requests.post(callback_url, json=result_data, timeout=30)
        except Exception as e:
            # Log failure (to stderr usually)
            sys.stderr.write(f"Callback failed: {e}\n")

def main():
    # Read stdin
    try:
        input_data = sys.stdin.read()
        if not input_data:
            return
        request = json.loads(input_data)
    except Exception as e:
        print(json.dumps({"status": "error", "error": "Invalid JSON input"}))
        return

    command = request.get("command")

    # Generate Task ID
    task_id = f"aicapcut_{int(time.time())}_{os.urandom(2).hex()}"

    # Start Background Thread
    t = threading.Thread(target=handle_async_task, args=(task_id, command, request))
    t.start()

    # Return Immediate Response
    placeholder = f"{{{{VCP_ASYNC_RESULT::AICapCut::{task_id}}}}}"
    print(json.dumps({
        "status": "success",
        "result": f"Task submitted. Result will appear here: {placeholder}"
    }))

if __name__ == "__main__":
    main()

import asyncio
import websockets
import json
import base64
import os
import time
import io
import mss
from PIL import Image

# Configuration
# In a real app, load these from config.env or args
VCP_SERVER_URL = os.environ.get("VCP_SERVER_URL", "ws://localhost:3000")
VCP_KEY = os.environ.get("VCP_KEY", "123456")

# The specific path for DesktopClient connection defined in WebSocketServer.js
# Note: We need to implement this route in WebSocketServer.js first!
# Based on my plan, I will add: /vcp-desktop-client/VCP_Key=...
WS_URI = f"{VCP_SERVER_URL}/vcp-desktop-client/VCP_Key={VCP_KEY}"

is_capturing = False
capture_interval = 2.0 # Seconds between captures (adjust for performance)
last_capture_time = 0

async def capture_and_send(websocket):
    global last_capture_time

    with mss.mss() as sct:
        # Capture the primary monitor
        monitor = sct.monitors[1]

        while True:
            if is_capturing:
                now = time.time()
                if now - last_capture_time >= capture_interval:
                    try:
                        # Grab the screen
                        sct_img = sct.grab(monitor)

                        # Convert to PIL Image
                        img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")

                        # Resize for performance/token savings (e.g., max dimension 1024)
                        img.thumbnail((1024, 1024))

                        # Save to buffer as JPEG
                        buffer = io.BytesIO()
                        img.save(buffer, format="JPEG", quality=70)
                        base64_data = base64.b64encode(buffer.getvalue()).decode('utf-8')

                        # Send to server
                        message = {
                            "type": "screen_update",
                            "data": {
                                "image": base64_data,
                                "timestamp": now
                            }
                        }
                        await websocket.send(json.dumps(message))
                        print(f"[Client] Sent frame. Size: {len(base64_data)} bytes.")

                        last_capture_time = now
                    except Exception as e:
                        print(f"[Client] Capture error: {e}")

            await asyncio.sleep(0.1) # Small sleep to prevent CPU hogging

async def handle_messages(websocket):
    global is_capturing
    async for message in websocket:
        try:
            msg = json.loads(message)
            print(f"[Client] Received: {msg}")

            if msg.get("type") == "command":
                cmd = msg.get("command")
                if cmd == "start_capture":
                    is_capturing = True
                    print("[Client] Started capturing.")
                elif cmd == "stop_capture":
                    is_capturing = False
                    print("[Client] Stopped capturing.")
        except Exception as e:
            print(f"[Client] Error parsing message: {e}")

async def main():
    print(f"Connecting to {WS_URI}...")
    async with websockets.connect(WS_URI) as websocket:
        print("Connected to VCP Server.")

        # Identify ourselves (optional if URL path handles it)
        # await websocket.send(json.dumps({"type": "identify", "clientType": "DesktopClient"}))

        # Run capture loop and message listener concurrently
        await asyncio.gather(
            handle_messages(websocket),
            capture_and_send(websocket)
        )

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Exiting...")

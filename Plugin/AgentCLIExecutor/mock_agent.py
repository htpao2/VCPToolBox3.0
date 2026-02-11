import sys
import time
import argparse
import os

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--time", type=int, default=2, help="Sleep time")
    parser.add_argument("--fail", action="store_true", help="Simulate failure")
    args, unknown = parser.parse_known_args()

    print(f"Mock Agent Started [PID: {os.getpid()}]. Sleeping for {args.time} seconds...")
    sys.stdout.flush()

    # Read stdin if available
    # In VCP context, stdin might be piped.
    try:
        # Check if there is data in stdin?
        # Reading stdin might block if nothing is sent and pipe is open.
        # But agent_handler.py sends input=instruction, so it closes stdin after writing?
        # subprocess.run() writes input and closes stdin. So sys.stdin.read() should work and return EOF.
        stdin_content = sys.stdin.read()
        if stdin_content:
            print(f"\n--- Stdin Received ---\n{stdin_content}\n----------------------")
        else:
            print("No stdin content received.")
    except Exception as e:
        print(f"Error reading stdin: {e}")

    print(f"Unknown Args: {unknown}")

    time.sleep(args.time)

    if args.fail:
        print("Simulating failure!")
        sys.exit(1)

    print("Mock Agent Finished Successfully.")

if __name__ == "__main__":
    main()

"""CLI entry point for Claude Cockpit Web server."""

import os
import sys


def main():
    # Add web/ to path so auth module is importable
    web_dir = os.path.join(os.path.dirname(__file__), "..", "..", "web")
    sys.path.insert(0, os.path.abspath(web_dir))

    import uvicorn
    port = int(os.getenv("PORT", "8420"))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"\n  Claude Cockpit Web → http://{host}:{port}\n")
    uvicorn.run("server:app", host=host, port=port, app_dir=os.path.abspath(web_dir))


if __name__ == "__main__":
    main()

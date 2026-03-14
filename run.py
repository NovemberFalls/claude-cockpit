#!/usr/bin/env python3
"""Quick-start entry point for Claude Cockpit."""

import sys
from pathlib import Path

# Add src to path for development
sys.path.insert(0, str(Path(__file__).parent / "src"))

from cockpit.cli import main

if __name__ == "__main__":
    main()

"""Logging configuration for Claude Cockpit."""

import logging
import sys


def setup(level: str = "INFO"):
    """Configure structured logging for all cockpit modules."""
    log_level = getattr(logging, level.upper(), logging.INFO)

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)

    # Configure root cockpit logger
    root = logging.getLogger("cockpit")
    root.setLevel(log_level)
    root.addHandler(handler)
    root.propagate = False

    return root

"""Where the optional models (the hf classifier, sentence-transformers embeddings) run.

The default rules classifier and hash embeddings are plain Python and run no model, so AI_DEVICE
only matters once one of those optional backends is selected.
"""

import importlib
import logging

log = logging.getLogger("agentbazaar_ai")


def resolve_device(requested: str) -> str:
    """``cuda`` when asked for and PyTorch sees a GPU, else ``cpu``, which always works."""
    if requested != "cuda":
        return "cpu"
    try:
        available = bool(importlib.import_module("torch").cuda.is_available())
    except Exception:  # no PyTorch, a CPU-only build or a broken driver all mean the CPU
        available = False
    if not available:
        log.warning(
            "AI_DEVICE=cuda but PyTorch sees no CUDA device; optional models run on the CPU"
        )
    return "cuda" if available else "cpu"

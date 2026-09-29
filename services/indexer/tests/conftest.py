"""Integration-test fixtures: a live Anvil node + a freshly-deployed registry stack.

The contract-derived tiers run against a real chain (``docs/TESTING.md``). A session-scoped
Anvil subprocess is started on a free port; each test gets a clean chain (``anvil_reset``) with
a fresh deployment from the pinned per-version fixtures (``tests/fixtures/``). Tests are
skipped when the ``anvil`` binary is absent (so a node-less environment doesn't fail the
suite); no Foundry build is needed.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time

import pytest
from web3 import Web3

from harness import deploy_stack, Chain


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="session")
def node():
    """A session-scoped Anvil node; yields a connected ``Web3``."""
    if shutil.which("anvil") is None:
        # A node-less laptop skips cleanly, but CI must never go green while
        # silently testing nothing (GitHub Actions always sets CI=true).
        if os.environ.get("CI"):
            pytest.fail("anvil is required in CI: the node tiers must run, not skip")
        pytest.skip("anvil not installed (integration tier needs a node)")

    port = _free_port()
    proc = subprocess.Popen(
        ["anvil", "--silent", "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    w3 = Web3(Web3.HTTPProvider(f"http://127.0.0.1:{port}"))
    try:
        for _ in range(200):
            try:
                if w3.is_connected():
                    break
            except Exception:
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("anvil did not become ready")
        yield w3
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


@pytest.fixture
def chain(node) -> Chain:
    """A clean chain with a freshly-deployed registry stack for one test."""
    node.provider.make_request("anvil_reset", [])
    return Chain(node, deploy_stack(node))

"""Data API and CLI for Swarm ``VolumeRegistry`` deployments.

See ``docs/ARCHITECTURE.md`` for the component layout, ``docs/SCHEMA.md`` for
the artifact wire format, and ``docs/TESTING.md`` for the test strategy this
package's test suite implements.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("ethswarm-volumes")
except PackageNotFoundError:
    # Package is not installed (e.g. imported straight from a source checkout);
    # fall back rather than fail at import time.
    __version__ = "0.0.0"

__all__ = ["__version__"]

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import export_deployment  # noqa: E402


PROFILE_NAME = "sepolia-postage-v0.9.4"
VERSION = "v2-rc1"
PROFILE = {
    "chain_id": 11155111,
    "postage_stamp": "0xcdfdC3752caaA826fE62531E0000C40546eC56A6",
    "bzz": "0x543dDb01Ba47acB11de34891cD86B675F04840db",
    "grace_blocks": 12,
}
ADDRESS = "0x33a53c79a08ed1f863905cd4c6ce036a4c493729"
TX_HASH = "0x59dd245cd9d30e53175a38930b437f9048c5ce47ff20588ec46fd4359d225924"


def broadcast_fixture() -> dict:
    return {
        "transactions": [
            {
                "hash": TX_HASH,
                "transactionType": "CREATE",
                "contractName": "VolumeRegistry",
                "contractAddress": ADDRESS,
                "arguments": [PROFILE["postage_stamp"], PROFILE["bzz"], "12"],
                "transaction": {"input": "0x6000c0ffee"},
            }
        ],
        "receipts": [
            {
                "status": "0x1",
                "transactionHash": TX_HASH,
                "transactionIndex": "0x2",
                "blockHash": "0x" + "ab" * 32,
                "blockNumber": "0x10",
                "gasUsed": "0x123",
                "contractAddress": ADDRESS,
            }
        ],
        "timestamp": 1787275286220,
        "chain": 11155111,
        "commit": "f606e9a",
    }


class BuildManifestTests(unittest.TestCase):
    def build(self, broadcast: dict | None = None) -> dict:
        return export_deployment.build_manifest(
            PROFILE_NAME,
            VERSION,
            PROFILE,
            broadcast or broadcast_fixture(),
            {
                "abi": [{"type": "constructor", "inputs": []}],
                "bytecode": {"object": "0x6000"},
            },
            "VolumeRegistry",
            export_deployment.CONTRACTS / "broadcast/example/run-latest.json",
        )

    def test_builds_compatible_manifest(self) -> None:
        manifest = self.build()

        self.assertEqual(manifest["address"], ADDRESS)
        self.assertEqual(manifest["transactionHash"], TX_HASH)
        self.assertEqual(manifest["receipt"]["status"], 1)
        self.assertEqual(manifest["receipt"]["blockNumber"], 16)
        self.assertEqual(manifest["receipt"]["transactionIndex"], 2)
        self.assertEqual(manifest["receipt"]["gasUsed"], "291")
        self.assertTrue(manifest["receipt"]["byzantium"])
        self.assertEqual(manifest["args"][2], 12)
        self.assertEqual(manifest["linkedData"]["chainId"], 11155111)
        self.assertEqual(manifest["linkedData"]["version"], VERSION)

    def test_rejects_wrong_chain(self) -> None:
        broadcast = broadcast_fixture()
        broadcast["chain"] = 100

        with self.assertRaisesRegex(SystemExit, "requires chain 11155111"):
            self.build(broadcast)

    def test_rejects_failed_receipt(self) -> None:
        broadcast = broadcast_fixture()
        broadcast["receipts"][0]["status"] = "0x0"

        with self.assertRaisesRegex(SystemExit, "did not succeed"):
            self.build(broadcast)

    def test_rejects_constructor_argument_mismatch(self) -> None:
        broadcast = broadcast_fixture()
        broadcast["transactions"][0]["arguments"][2] = "13"

        with self.assertRaisesRegex(SystemExit, "graceBlocks"):
            self.build(broadcast)

    def test_rejects_artifact_from_another_build(self) -> None:
        with self.assertRaisesRegex(SystemExit, "artifact bytecode does not match"):
            export_deployment.build_manifest(
                PROFILE_NAME,
                VERSION,
                PROFILE,
                broadcast_fixture(),
                {"abi": [], "bytecode": {"object": "0x1234"}},
                "VolumeRegistry",
                export_deployment.CONTRACTS / "broadcast/example/run-latest.json",
            )


class WriteManifestTests(unittest.TestCase):
    def write(self, root: Path, manifest: dict, *, version: str = VERSION, latest: bool = False):
        return export_deployment.write_manifest(
            root, "sepolia", "VolumeRegistry", version, 11155111, manifest, latest=latest
        )

    def test_writes_network_chain_and_versioned_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            written = self.write(root, {"address": ADDRESS})

            self.assertEqual((root / "sepolia/.chainId").read_text(), "11155111\n")
            self.assertEqual(written, [root / "sepolia/VolumeRegistry-v2-rc1.json"])
            self.assertIn(ADDRESS, written[0].read_text())
            self.assertFalse((root / "sepolia/VolumeRegistry.json").exists())

    def test_latest_pointer_is_written_only_on_request(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, {"address": ADDRESS}, latest=True)
            other = "0x" + "11" * 20
            self.write(root, {"address": other}, version="v2-rc2")

            latest = root / "sepolia/VolumeRegistry.json"
            self.assertEqual(
                latest.read_text(), (root / "sepolia/VolumeRegistry-v2-rc1.json").read_text()
            )

            self.write(root, {"address": other}, version="v2-rc2", latest=True)
            self.assertIn(other, latest.read_text())

    def test_refuses_a_second_deployment_under_one_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, {"address": ADDRESS})
            self.write(root, {"address": ADDRESS.upper().replace("0X", "0x")})  # re-export ok

            with self.assertRaisesRegex(SystemExit, "a new deployment needs a new version"):
                self.write(root, {"address": "0x" + "11" * 20})

    def test_refuses_to_reuse_network_name_for_another_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sepolia").mkdir()
            (root / "sepolia/.chainId").write_text("100\n")

            with self.assertRaisesRegex(SystemExit, "already records chain 100"):
                self.write(root, {"address": ADDRESS})


class VersionNameTests(unittest.TestCase):
    def test_accepts_releases_and_release_candidates(self) -> None:
        for name in ("v1", "v2", "v2-rc1", "v10-rc12"):
            self.assertTrue(export_deployment.VERSION_NAME.fullmatch(name), name)

    def test_rejects_other_names(self) -> None:
        for name in ("2", "v0", "v2rc1", "v2-rc0", "v2-beta1", "V2", "v2-rc"):
            self.assertFalse(export_deployment.VERSION_NAME.fullmatch(name), name)


class CommittedRecordTests(unittest.TestCase):
    """The committed deployments/ tree obeys the naming scheme the exporter writes."""

    def test_records_are_versioned_and_latest_pointers_copy_one(self) -> None:
        root = export_deployment.CONTRACTS / export_deployment.DEFAULT_DEPLOYMENTS
        for network_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            versioned = {}
            for path in network_dir.glob("VolumeRegistry-*.json"):
                version = path.stem.removeprefix("VolumeRegistry-")
                with self.subTest(record=str(path.relative_to(root))):
                    self.assertTrue(export_deployment.VERSION_NAME.fullmatch(version))
                    record = export_deployment.read_json(path, "deployment record")
                    self.assertEqual(record["linkedData"]["version"], version)
                versioned[version] = path.read_bytes()

            latest = network_dir / "VolumeRegistry.json"
            if latest.exists():
                with self.subTest(latest=str(latest.relative_to(root))):
                    self.assertIn(latest.read_bytes(), versioned.values())


if __name__ == "__main__":
    unittest.main()

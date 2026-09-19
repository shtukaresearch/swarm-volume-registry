from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import export_deployment  # noqa: E402


PROFILE_NAME = "sepolia-postage-v0.9.4"
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
                PROFILE,
                broadcast_fixture(),
                {"abi": [], "bytecode": {"object": "0x1234"}},
                "VolumeRegistry",
                export_deployment.CONTRACTS / "broadcast/example/run-latest.json",
            )


class WriteManifestTests(unittest.TestCase):
    def test_writes_network_chain_and_contract_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = export_deployment.write_manifest(
                root, "sepolia", "VolumeRegistry", 11155111, {"address": ADDRESS}
            )

            self.assertEqual((root / "sepolia/.chainId").read_text(), "11155111\n")
            self.assertIn(ADDRESS, output.read_text())

    def test_refuses_to_reuse_network_name_for_another_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sepolia").mkdir()
            (root / "sepolia/.chainId").write_text("100\n")

            with self.assertRaisesRegex(SystemExit, "already records chain 100"):
                export_deployment.write_manifest(
                    root, "sepolia", "VolumeRegistry", 11155111, {"address": ADDRESS}
                )


if __name__ == "__main__":
    unittest.main()

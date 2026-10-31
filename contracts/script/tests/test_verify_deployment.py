from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import verify_deployment

SEPOLIA_PROFILE = {
    "chain_id": 11155111,
    "postage_stamp": "0xcdfdC3752caaA826fE62531E0000C40546eC56A6",
    "bzz": "0x543dDb01Ba47acB11de34891cD86B675F04840db",
    "grace_blocks": 12,
    "bzz_permit_expiry": False,
    "deployment_network": "sepolia",
    "verifier": "etherscan",
    "verifier_api_key_env": "ETHERSCAN_API_KEY",
    "explorer_url": "https://sepolia.etherscan.io/address/{address}#code",
}


class VerificationSettingsTests(unittest.TestCase):
    def test_loads_etherscan_settings_from_profile_and_environment(self) -> None:
        with patch.dict(os.environ, {"ETHERSCAN_API_KEY": "test-key"}):
            settings = verify_deployment.verification_settings("sepolia", SEPOLIA_PROFILE)

        self.assertEqual(settings["network"], "sepolia")
        self.assertEqual(settings["verifier"], "etherscan")
        self.assertEqual(settings["api_key_env"], "ETHERSCAN_API_KEY")

    def test_requires_configured_api_key_environment_variable(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(SystemExit, "ETHERSCAN_API_KEY must be set"),
        ):
            verify_deployment.verification_settings("sepolia", SEPOLIA_PROFILE)

    def test_requires_blockscout_url(self) -> None:
        profile = dict(SEPOLIA_PROFILE)
        profile.update(
            {
                "deployment_network": "gnosis",
                "verifier": "blockscout",
                "explorer_url": "https://gnosis.blockscout.com/address/{address}",
            }
        )
        profile.pop("verifier_api_key_env")

        with self.assertRaisesRegex(SystemExit, "must configure verifier_url"):
            verify_deployment.verification_settings("gnosis", profile)

    def test_loads_keyless_blockscout_settings(self) -> None:
        profile = dict(SEPOLIA_PROFILE)
        profile.update(
            {
                "deployment_network": "gnosis",
                "verifier": "blockscout",
                "verifier_url": "https://gnosis.blockscout.com/api/",
                "explorer_url": "https://gnosis.blockscout.com/address/{address}",
            }
        )
        profile.pop("verifier_api_key_env")

        settings = verify_deployment.verification_settings("gnosis", profile)

        self.assertEqual(settings["verifier"], "blockscout")
        self.assertNotIn("api_key_env", settings)


class LoadDeploymentTests(unittest.TestCase):
    PROFILE = "sepolia-postage-v0.9.4"
    ADDRESS = "0x" + "ab" * 20

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.contracts = Path(tmp.name)
        patcher = patch.object(verify_deployment, "CONTRACTS", self.contracts)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_record(self, args: list) -> None:
        record = {
            "address": self.ADDRESS,
            "args": args,
            "linkedData": {"chainId": 11155111, "profile": self.PROFILE, "version": "v2-rc4"},
        }
        directory = self.contracts / "deployments" / "sepolia"
        directory.mkdir(parents=True)
        (directory / "VolumeRegistry-v2-rc4.json").write_text(json.dumps(record))

    def profile_args(self) -> list:
        return [SEPOLIA_PROFILE["postage_stamp"], SEPOLIA_PROFILE["bzz"], 12, False]

    def test_loads_the_versioned_record(self) -> None:
        self.write_record(self.profile_args())
        path, deployment = verify_deployment.load_deployment(
            self.PROFILE, SEPOLIA_PROFILE, "sepolia", "v2-rc4"
        )

        self.assertEqual(path.name, "VolumeRegistry-v2-rc4.json")
        self.assertEqual(deployment["address"], self.ADDRESS)

    def test_rejects_permit_expiry_mismatch(self) -> None:
        self.write_record(self.profile_args()[:3] + [True])
        with self.assertRaisesRegex(SystemExit, "bzzPermitExpiry does not match"):
            verify_deployment.load_deployment(self.PROFILE, SEPOLIA_PROFILE, "sepolia", "v2-rc4")

    def test_rejects_a_three_argument_record(self) -> None:
        self.write_record(self.profile_args()[:3])
        with self.assertRaisesRegex(SystemExit, "missing constructor arguments"):
            verify_deployment.load_deployment(self.PROFILE, SEPOLIA_PROFILE, "sepolia", "v2-rc4")

    def test_requires_a_record_for_the_version(self) -> None:
        with self.assertRaisesRegex(SystemExit, "deployment record not found"):
            verify_deployment.load_deployment(self.PROFILE, SEPOLIA_PROFILE, "sepolia", "v2-rc9")


class VerificationCommandTests(unittest.TestCase):
    def test_encodes_profile_constructor_arguments(self) -> None:
        encoded = verify_deployment.encode_constructor(SEPOLIA_PROFILE)

        self.assertRegex(encoded, verify_deployment.ENCODED_CONSTRUCTOR)
        self.assertTrue(encoded.endswith("0" * 63 + "c" + "0" * 64))

    def test_builds_etherscan_command(self) -> None:
        settings = {"verifier": "etherscan"}
        command = verify_deployment.verification_command(
            SEPOLIA_PROFILE,
            settings,
            "0x33a53c79a08ed1f863905cd4c6ce036a4c493729",
            "https://rpc.example",
            "0x1234",
        )

        self.assertEqual(command[:2], ["forge", "verify-contract"])
        self.assertIn("11155111", command)
        self.assertIn("etherscan", command)
        self.assertNotIn("--verifier-url", command)
        self.assertEqual(command[-1], "--watch")

    def test_builds_blockscout_command_with_instance_url(self) -> None:
        settings = {
            "verifier": "blockscout",
            "verifier_url": "https://gnosis.blockscout.com/api/",
        }
        profile = dict(SEPOLIA_PROFILE, chain_id=100)
        command = verify_deployment.verification_command(
            profile,
            settings,
            "0x33a53c79a08ed1f863905cd4c6ce036a4c493729",
            "https://rpc.gnosischain.com",
            "0x1234",
        )

        self.assertIn("blockscout", command)
        self.assertIn("--verifier-url", command)
        self.assertIn("https://gnosis.blockscout.com/api/", command)


if __name__ == "__main__":
    unittest.main()

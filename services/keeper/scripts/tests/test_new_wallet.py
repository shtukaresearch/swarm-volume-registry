"""Tests for the pure parts of scripts/new_wallet.py; nothing here runs cast."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import new_wallet


class AccountName(unittest.TestCase):
    def test_is_the_worker_name(self) -> None:
        self.assertEqual(
            new_wallet.account_name("sepolia-v2-rc3"),
            "keeper-cloudflare-sepolia-v2-rc3",
        )


class RecordChainId(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.records = Path(self.tmp.name) / "contracts" / "deployments"
        sepolia = self.records / "sepolia"
        sepolia.mkdir(parents=True)
        (sepolia / ".chainId").write_text("11155111\n")
        (sepolia / "VolumeRegistry-v2-rc3.json").write_text("{}")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_reads_the_networks_chain_id(self) -> None:
        self.assertEqual(
            new_wallet.record_chain_id("sepolia-v2-rc3", self.records), 11155111
        )

    def test_refuses_a_release_with_no_record(self) -> None:
        with self.assertRaises(SystemExit):
            new_wallet.record_chain_id("sepolia-v2-rc4", self.records)

    def test_refuses_a_network_with_no_records(self) -> None:
        with self.assertRaises(SystemExit):
            new_wallet.record_chain_id("gnosis-v2", self.records)

    def test_refuses_what_is_not_a_label(self) -> None:
        for label in ("sepolia", "v2-rc3", "sepolia-v2-rc0", "Sepolia-v2", "sepolia-2"):
            with self.subTest(label=label), self.assertRaises(SystemExit):
                new_wallet.record_chain_id(label, self.records)


class ParseValue(unittest.TestCase):
    def test_passes_ether_units_to_cast(self) -> None:
        self.assertEqual(new_wallet.parse_value("0.2"), "0.2ether")

    def test_refuses_nonpositive_or_malformed_amounts(self) -> None:
        for value in ("0", "-1", "abc", "NaN", "Infinity"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                new_wallet.parse_value(value)


class CheckKeystore(unittest.TestCase):
    def test_a_new_wallet_needs_a_free_name(self) -> None:
        new_wallet.check_keystore("k", exists=False, existing=False)
        with self.assertRaises(SystemExit):
            new_wallet.check_keystore("k", exists=True, existing=False)

    def test_existing_needs_the_account(self) -> None:
        new_wallet.check_keystore("k", exists=True, existing=True)
        with self.assertRaises(SystemExit):
            new_wallet.check_keystore("k", exists=False, existing=True)


class ReportedAddress(unittest.TestCase):
    def test_reads_the_bare_address_cast_prints_on_stdout(self) -> None:
        self.assertEqual(
            new_wallet.reported_address("0x09f6A576cC728450eB8815448b67a1A9B931F6fB\n"),
            "0x09f6A576cC728450eB8815448b67a1A9B931F6fB",
        )

    def test_fails_on_anything_else(self) -> None:
        labelled = "Address:    0x09f6A576cC728450eB8815448b67a1A9B931F6fB\n"
        for output in ("", "Error: bad password\n", "0x1234\n", labelled):
            with self.subTest(output=output), self.assertRaises(SystemExit):
                new_wallet.reported_address(output)


if __name__ == "__main__":
    unittest.main()

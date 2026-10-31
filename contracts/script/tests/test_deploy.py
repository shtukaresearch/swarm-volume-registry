from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import deploy

PROFILE_NAME = "sepolia-postage-v0.9.4-1h"
PASSWORD = "correct horse battery staple"
VERSION = "v2-rc3"
BASE_ARGS = [
    PROFILE_NAME,
    "--version",
    VERSION,
    "--rpc-url",
    "http://rpc.invalid",
    "--account",
    "deployer",
]


class FakeRun:
    """Stand-in for subprocess.run that answers forge/cast/zenity calls.

    For `forge script` it records argv, kwargs and environment, and reads the
    password through the file named by `--password-file`, as forge would.
    """

    def __init__(self, zenity_returncode: int = 0, factory_code: str = "0x7fffffff") -> None:
        self.zenity_returncode = zenity_returncode
        self.factory_code = factory_code
        self.script_calls: list[tuple[list[str], dict]] = []
        self.password_read: str | None = None
        self.password_is_regular_file = False
        self.zenity_called = False

    def __call__(self, command: list[str], **kwargs) -> subprocess.CompletedProcess:
        if command[:2] == ["forge", "--version"]:
            return subprocess.CompletedProcess(command, 0, "forge Version: 1.7.1-stable\n", "")
        if command[:2] == ["cast", "chain-id"]:
            return subprocess.CompletedProcess(command, 0, "11155111\n", "")
        if command[:2] == ["cast", "code"]:
            assert command[2] == deploy.CREATE2_FACTORY, command
            return subprocess.CompletedProcess(command, 0, self.factory_code + "\n", "")
        if command[0] == "zenity":
            self.zenity_called = True
            return subprocess.CompletedProcess(command, self.zenity_returncode, PASSWORD + "\n", "")
        if command[:2] == ["forge", "script"]:
            self.script_calls.append((command, kwargs))
            if "--password-file" in command:
                path = command[command.index("--password-file") + 1]
                # Forge rejects anything but a regular file (e.g. a pipe).
                self.password_is_regular_file = stat.S_ISREG(os.stat(path).st_mode)
                with open(path) as password_file:
                    self.password_read = password_file.read()
            return subprocess.CompletedProcess(command, 0, "", "")
        raise AssertionError(f"unexpected command {command}")


class Create2Tests(unittest.TestCase):
    def test_release_salt_is_the_padded_release_name(self) -> None:
        # cast format-bytes32-string v2-rc3
        self.assertEqual(
            deploy.release_salt("v2-rc3"),
            "0x76322d7263330000000000000000000000000000000000000000000000000000",
        )

    def test_release_salt_rejects_non_release_names(self) -> None:
        for name in ("v0", "2", "v2-rc", "v2-beta1", "latest"):
            with self.subTest(name=name), self.assertRaises(SystemExit):
                deploy.release_salt(name)

    def test_script_gets_salt_and_factory(self) -> None:
        fake = FakeRun()
        with mock.patch.object(deploy.subprocess, "run", fake):
            deploy.main(BASE_ARGS + ["--broadcast"])
        ((command, _),) = fake.script_calls
        sig = command.index(deploy.SCRIPT_SIGNATURE)
        self.assertEqual(deploy.SCRIPT_SIGNATURE, "run(address,address,uint64,bool,bytes32)")
        self.assertEqual(command[sig + 4], "false")
        self.assertEqual(command[sig + 5], deploy.release_salt(VERSION))
        self.assertEqual(command[command.index("--create2-deployer") + 1], deploy.CREATE2_FACTORY)

    def test_profiles_set_permit_expiry_for_gnosis_only(self) -> None:
        self.assertIs(deploy.load_profile("gnosis-postage-v0.9.4")["bzz_permit_expiry"], True)
        self.assertIs(deploy.load_profile(PROFILE_NAME)["bzz_permit_expiry"], False)

    def test_profile_requires_boolean_permit_expiry(self) -> None:
        profile = (
            "[profiles.p]\nchain_id = 1\n"
            'postage_stamp = "0x' + "11" * 20 + '"\nbzz = "0x' + "22" * 20 + '"\n'
            "grace_blocks = 12\n"
        )
        for extra, message in (
            ("", "missing 'bzz_permit_expiry'"),
            ('bzz_permit_expiry = "yes"\n', "invalid bzz_permit_expiry"),
        ):
            with tempfile.TemporaryDirectory() as tmp, self.subTest(extra=extra):
                config = Path(tmp) / "deployments.toml"
                config.write_text(profile + extra)
                with (
                    mock.patch.object(deploy, "CONFIG", config),
                    self.assertRaisesRegex(SystemExit, message),
                ):
                    deploy.load_profile("p")

    def test_missing_factory_aborts_before_forge(self) -> None:
        fake = FakeRun(factory_code="0x")
        with (
            mock.patch.object(deploy.subprocess, "run", fake),
            self.assertRaisesRegex(SystemExit, "has no code"),
        ):
            deploy.main(BASE_ARGS + ["--broadcast"])
        self.assertEqual(fake.script_calls, [])

    def test_invalid_release_name_aborts_before_forge(self) -> None:
        fake = FakeRun()
        args = list(BASE_ARGS)
        args[args.index(VERSION)] = "rc3"
        with (
            mock.patch.object(deploy.subprocess, "run", fake),
            self.assertRaisesRegex(SystemExit, "invalid release name"),
        ):
            deploy.main(args)
        self.assertEqual(fake.script_calls, [])


class GasEstimationTests(unittest.TestCase):
    def test_broadcast_estimates_gas_via_rpc(self) -> None:
        fake = FakeRun()
        with mock.patch.object(deploy.subprocess, "run", fake):
            deploy.main(BASE_ARGS + ["--broadcast"])
        ((command, _),) = fake.script_calls
        self.assertIn("--skip-simulation", command)

    def test_dry_run_keeps_local_simulation(self) -> None:
        fake = FakeRun()
        with mock.patch.object(deploy.subprocess, "run", fake):
            deploy.main(BASE_ARGS)
        ((command, _),) = fake.script_calls
        self.assertNotIn("--skip-simulation", command)
        self.assertNotIn("--broadcast", command)


class PasswordPromptTests(unittest.TestCase):
    def run_main(self, args: list[str], fake: FakeRun) -> None:
        with mock.patch.object(deploy.subprocess, "run", fake):
            deploy.main(args)

    def test_password_passed_through_inherited_fd_only(self) -> None:
        fake = FakeRun()
        self.run_main(BASE_ARGS + ["--broadcast", "--password-prompt"], fake)

        self.assertTrue(fake.zenity_called)
        self.assertEqual(fake.password_read, PASSWORD)
        self.assertTrue(fake.password_is_regular_file)
        ((command, kwargs),) = fake.script_calls
        path = command[command.index("--password-file") + 1]
        fd = int(path.removeprefix("/dev/fd/"))
        self.assertEqual(kwargs["pass_fds"], (fd,))
        self.assertNotIn(PASSWORD, " ".join(command))
        self.assertNotIn(PASSWORD, "".join(os.environ.values()))
        self.assertNotIn("env", kwargs)
        self.assertIn("--broadcast", command)
        self.assertIn("--skip-simulation", command)
        with self.assertRaises(OSError):
            os.fstat(fd)  # closed after forge exits

    def test_cancelled_prompt_aborts_before_forge(self) -> None:
        fake = FakeRun(zenity_returncode=1)
        with self.assertRaisesRegex(SystemExit, "cancelled"):
            self.run_main(BASE_ARGS + ["--broadcast", "--password-prompt"], fake)
        self.assertEqual(fake.script_calls, [])

    def test_missing_zenity_aborts_before_forge(self) -> None:
        fake = FakeRun()

        def no_zenity(command: list[str], **kwargs) -> subprocess.CompletedProcess:
            if command[0] == "zenity":
                raise FileNotFoundError(command[0])
            return fake(command, **kwargs)

        with (
            mock.patch.object(deploy.subprocess, "run", no_zenity),
            self.assertRaisesRegex(SystemExit, "requires zenity"),
        ):
            deploy.main(BASE_ARGS + ["--broadcast", "--password-prompt"])
        self.assertEqual(fake.script_calls, [])

    def test_prompt_requires_account(self) -> None:
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            self.run_main(
                [
                    PROFILE_NAME,
                    "--version",
                    VERSION,
                    "--rpc-url",
                    "http://rpc.invalid",
                    "--password-prompt",
                ],
                FakeRun(),
            )

    def test_without_prompt_forge_prompts_itself(self) -> None:
        fake = FakeRun()
        self.run_main(BASE_ARGS + ["--broadcast"], fake)

        self.assertFalse(fake.zenity_called)
        ((command, kwargs),) = fake.script_calls
        self.assertNotIn("--password-file", command)
        self.assertNotIn("pass_fds", kwargs)


if __name__ == "__main__":
    unittest.main()

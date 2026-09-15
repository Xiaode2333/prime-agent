"""bash() on Windows with no POSIX shell installed (PowerShell or cmd.exe only).

These tests run the real spawn path -- CreateProcessW inside a kill-on-close job
object, with the wrapper's stdout status channel -- so they are skipped off
Windows. The POSIX status channel (fd 9) keeps its tests in test_bash.py, which
must stay green and is not weakened by anything here. WrapperGenerationTest is
pure string/argv checks and runs on every platform.
"""

from __future__ import annotations

import asyncio
import glob
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from rlm import bash

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]

windows_only = unittest.skipUnless(os.name == "nt", "Windows shell semantics")

_SYSTEM_ROOT = os.environ.get("SystemRoot", r"C:\Windows")
_POWERSHELL = os.path.join(_SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
_CMD = os.path.join(_SYSTEM_ROOT, "System32", "cmd.exe")
# The bare marker prefix: never user-visible output on any path.
_FENCE_TEXT = bash_module._WIN_COMPLETION_PREFIX.decode()

# A process tree query for kill() coverage: cmd.exe and ping are grandchildren of
# the shell process, so a leader-only kill would leave them running.
_TREE_QUERY = (
    'Get-CimInstance Win32_Process | ForEach-Object '
    '{ "$($_.ProcessId) $($_.ParentProcessId)" }'
)


def _process_children_blocking() -> dict[int, list[int]]:
    completed = subprocess.run(
        [_POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", _TREE_QUERY],
        capture_output=True,
        text=True,
        timeout=120,
    )
    children: dict[int, list[int]] = {}
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    return children


async def _process_children() -> dict[int, list[int]]:
    # The CIM query takes about a second; to_thread keeps the awaited handle's
    # asyncio loop free while it runs.
    return await asyncio.to_thread(_process_children_blocking)


async def _descendants(root: int) -> list[int]:
    children = await _process_children()
    found: list[int] = []
    pending = list(children.get(root, ()))
    while pending:
        pid = pending.pop()
        found.append(pid)
        pending.extend(children.get(pid, ()))
    return found


async def _live_pids() -> set[int]:
    return {pid for pids in (await _process_children()).values() for pid in pids}


class WindowsShellTest(unittest.IsolatedAsyncioTestCase):
    """No POSIX shell: PRIME_AGENT_BASH_SHELL is unset, so bash() must use the
    shipped Windows shell. Skipped off Windows."""

    def setUp(self) -> None:
        if os.name != "nt":
            self.skipTest("Windows shell semantics")
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop("PRIME_AGENT_BASH_SHELL", None)
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)

    def _track(self, handle: bash_module.BashHandle) -> bash_module.BashHandle:
        self.addCleanup(handle.kill)
        return handle

    async def test_default_shell_is_the_shipped_windows_shell(self):
        shell = bash_module._shell()
        self.assertTrue(shell.lower().startswith(_SYSTEM_ROOT.lower()))
        self.assertIn(bash_module._shell_kind(shell), ("powershell", "cmd"))

    async def test_simple_command(self):
        result = await self._track(bash("Write-Output hi"))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertGreaterEqual(result.duration, 0)

    async def test_exit_statement_reports_real_exit_code(self):
        # `exit N` leaves before the wrapper's marker line, so this pins the
        # exit-code fallback rather than the status channel.
        self.assertEqual((await self._track(bash("exit 5"))).exit_code, 5)

    async def test_terminating_error_reports_failure(self):
        # Same fallback: PowerShell exits 1 for a terminating error and prints the
        # error text to the captured stream.
        result = await self._track(bash("throw 'boom'"))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("boom", result.output)

    async def test_error_context_shows_only_the_user_statement(self):
        # A command ending on an unterminated token makes PowerShell's parser read
        # on into the next statement. That statement must be the wrapper's bare `;`,
        # so the error names the user's own text and no wrapper statement is drawn
        # into the context or glued into the captured output.
        result = await self._track(bash("Get-ChildItem |"))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Get-ChildItem |", result.output)
        for wrapper_text in ("$__prime", "$global:LASTEXITCODE", _FENCE_TEXT):
            self.assertNotIn(wrapper_text, result.output)

        # A trailing comma glues the next statement into the command: it must not
        # print anything of the wrapper's.
        result = await self._track(bash("Write-Output 1,"))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Write-Output 1,", result.output)
        for wrapper_text in ("$__prime", _FENCE_TEXT):
            self.assertNotIn(wrapper_text, result.output)

    async def test_probe_survives_a_foreign_last_exit_code(self):
        # A command that leaves a non-numeric $LASTEXITCODE behind must not abort the
        # status probe (no wrapper error text), and $? decides the reported status.
        result = await self._track(bash("$global:LASTEXITCODE = 'nope'; Write-Output done"))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("done", result.output)
        self.assertNotIn("$__prime", result.output)

    async def test_failing_command_reports_real_exit_code(self):
        # PowerShell collapses a failing native command to 1 when it is the whole
        # -Command, so the wrapper has to recover the real code.
        result = await self._track(bash("cmd /c exit 3"))
        self.assertEqual(result.exit_code, 3)

        result = await self._track(bash("cmd /c exit 42"))
        self.assertEqual(result.exit_code, 42)

        # A failing cmdlet is not a native exit code: $? decides.
        result = await self._track(bash("Get-Item C:\\no-such-file-prime-agent"))
        self.assertEqual(result.exit_code, 1)
        self.assertTrue(result.output.strip())

    async def test_stdout_and_stderr_are_captured(self):
        result = await self._track(
            bash("[Console]::Error.Write('err-line' + \"`n\"); Write-Output out-line")
        )
        self.assertEqual(result.exit_code, 0)
        self.assertIn("out-line", result.output)
        self.assertIn("err-line", result.output)

    async def test_await_long_running_command(self):
        started = time.monotonic()
        handle = self._track(bash("Write-Output begin; Start-Sleep -Seconds 3; Write-Output end"))
        self.assertIsNone(handle.poll())
        self.assertTrue(handle.running)
        result = await asyncio.wait_for(handle, timeout=30)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("begin", result.output)
        self.assertIn("end", result.output)
        self.assertGreaterEqual(time.monotonic() - started, 2.5)

    async def test_background_handle_api(self):
        handle = self._track(bash("Write-Output first; Start-Sleep -Seconds 20"))
        for _ in range(100):
            if "first" in handle.output():
                break
            await asyncio.sleep(0.05)
        self.assertIn("first", handle.tail())
        self.assertIsNone(handle.poll())
        self.assertTrue(handle.running)
        handle.kill()
        result = await asyncio.wait_for(handle, timeout=15)
        self.assertNotEqual(result.exit_code, 0)
        self.assertFalse(handle.running)

    async def test_kill_terminates_child_tree(self):
        # shell (powershell) -> cmd.exe -> ping: containment must kill all three.
        handle = self._track(bash('cmd /c "ping -n 60 127.0.0.1 > NUL"'))
        tree: list[int] = []
        for _ in range(40):
            tree = await _descendants(handle.pid)
            if len(tree) >= 2:
                break
            await asyncio.sleep(0.25)
        self.assertGreaterEqual(len(tree), 2, f"no child tree observed under {handle.pid}")
        handle.kill()
        await asyncio.wait_for(handle, timeout=20)
        for _ in range(40):
            if not [pid for pid in tree if pid in await _live_pids()]:
                break
            await asyncio.sleep(0.25)
        self.assertEqual([pid for pid in tree if pid in await _live_pids()], [])

    async def test_exit_before_marker_with_detached_grandchild_still_returns(self):
        # `exit 4` skips the marker while a detached grandchild keeps the capture
        # pipe open, so neither the marker nor EOF can end the status wait: only
        # the shell-death release can (_release_stream_status). Without it the
        # await blocks until the grandchild exits, so the 15s bound below fails
        # while ping still has ~25s to run.
        handle = self._track(
            bash(
                "Start-Process -NoNewWindow -FilePath cmd "
                "-ArgumentList '/c','ping -n 30 127.0.0.1'; exit 4"
            )
        )
        started = time.monotonic()
        result = await asyncio.wait_for(handle, timeout=15)
        self.assertEqual(result.exit_code, 4)
        self.assertLess(time.monotonic() - started, 15)
        handle.kill()
        for _ in range(40):
            if not handle.running:
                break
            await asyncio.sleep(0.25)
        self.assertFalse(handle.running)

    async def test_status_line_never_reaches_output(self):
        result = await self._track(bash("Write-Output payload"))
        self.assertNotIn("prime-agent-complete", result.output)
        self.assertEqual(result.output.strip(), "payload")

    async def test_large_output_is_fully_captured(self):
        result = await self._track(bash("$i = 0; while ($i -lt 20000) { 'line ' + $i; $i++ }"))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("line 0", result.output)
        self.assertIn("line 19999", result.output)
        self.assertNotIn("prime-agent-complete", result.output)


class WindowsCmdShellTest(unittest.IsolatedAsyncioTestCase):
    """PRIME_AGENT_BASH_SHELL points at cmd.exe: the wrapper becomes a batch file."""

    def setUp(self) -> None:
        if os.name != "nt":
            self.skipTest("Windows shell semantics")
        if not os.path.exists(_CMD):
            self.skipTest("cmd.exe not present")
        self.enterContext(mock.patch.dict(os.environ))
        os.environ["PRIME_AGENT_BASH_SHELL"] = _CMD
        os.environ.pop("PRIME_AGENT_BASH_COMMAND_PREFIX", None)

    def _track(self, handle: bash_module.BashHandle) -> bash_module.BashHandle:
        self.addCleanup(handle.kill)
        return handle

    async def test_cmd_runs_commands_and_reports_exit_codes(self):
        result = await self._track(bash("echo from-cmd"))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("from-cmd", result.output)
        self.assertNotIn("prime-agent-complete", result.output)

        result = await self._track(bash("cmd /c exit 7"))
        self.assertEqual(result.exit_code, 7)

    async def test_cmd_multiline_command(self):
        # cmd.exe /c accepts only one line, so this only works from the batch file.
        result = await self._track(bash("echo one\r\necho two\r\ncmd /c exit 4"))
        self.assertEqual(result.exit_code, 4)
        self.assertIn("one", result.output)
        self.assertIn("two", result.output)

    async def test_batch_wrapper_is_removed_after_reap(self):
        with tempfile.TemporaryDirectory(prefix="prime agent spaced ") as temp:
            with mock.patch.dict(os.environ, {"TEMP": temp, "TMP": temp}):
                # A spaced temp path pins the /d /c quoting: /s would strip it.
                result = await self._track(bash("echo spaced"))
                self.assertEqual(result.exit_code, 0)
                self.assertIn("spaced", result.output)
                reaped = self._track(bash("cmd /c exit 5"))
                self.assertEqual((await reaped).exit_code, 5)
                for _ in range(40):
                    if not glob.glob(os.path.join(temp, "prime-agent-cmd-*")):
                        break
                    await asyncio.sleep(0.25)
                self.assertEqual(glob.glob(os.path.join(temp, "prime-agent-cmd-*")), [])


class WrapperGenerationTest(unittest.TestCase):
    """Pure wiring checks: these run on every platform, including POSIX CI."""

    def test_powershell_wrapper_carries_marker_and_status(self):
        wrapped = bash_module._powershell_wrapper("Write-Output hi", "deadbeef" * 8)
        lines = wrapped.splitlines()
        # The user's command is the first statement, so the line numbers PowerShell
        # reports for its own errors are the user's own.
        self.assertEqual(lines[0], "Write-Output hi")
        # A bare `;` terminates a command that ended on an unterminated token, so the
        # probe statements can never be parsed as (or blamed for) part of it.
        self.assertEqual(lines[1], ";")
        # $? must be read before the probe's own statements overwrite it.
        self.assertEqual(lines[2], "$__prime_ok = $?")
        self.assertEqual(lines[3], "$__prime_code = $LASTEXITCODE")
        # The [int] conversion is guarded: a user-set non-numeric $LASTEXITCODE must
        # not abort the status line, and the status is never .ToString()'d.
        self.assertIn("catch { $__prime_code = $null }", wrapped)
        self.assertIn('+ \"$__prime_status\"', wrapped)
        self.assertIn("exit $__prime_status", wrapped)
        # Parity with the POSIX script's trailing `wait`.
        self.assertIn("Wait-Job", wrapped)

    def test_cmd_wrapper_captures_errorlevel_before_echo(self):
        wrapped = bash_module._cmd_wrapper("echo hi", "deadbeef" * 8)
        lines = wrapped.splitlines()
        self.assertEqual(lines[0], "@echo off")
        self.assertEqual(lines[1], "echo hi")
        self.assertEqual(lines[2], 'set "__prime_status=%ERRORLEVEL%"')
        half = "deadbeef" * 4
        self.assertEqual(lines[3], f'set "__prime_fence={bash_module._WIN_COMPLETION_PREFIX.decode()}'
                                 f'{half}"')
        self.assertEqual(lines[4], f'set "__prime_fence=%__prime_fence%{half} %__prime_status%"')
        self.assertEqual(lines[5], "echo %__prime_fence%")
        self.assertEqual(lines[6], "exit /b %__prime_status%")

    def test_windows_wrappers_never_spell_out_the_marker(self):
        # Both wrappers assemble the fence from two halves, so the contiguous marker
        # never appears in the child's command line or in the batch file a command
        # can `type`: the bytes the pump matches on cannot be read back and replayed.
        token = "0123456789abcdef" * 4
        marker = bash_module._WIN_COMPLETION_PREFIX.decode() + token
        for wrapped in (
            bash_module._powershell_wrapper("Write-Output hi", token),
            bash_module._cmd_wrapper("echo hi", token),
        ):
            self.assertNotIn(marker, wrapped)
            self.assertIn(marker[: len(bash_module._WIN_COMPLETION_PREFIX) + 32], wrapped)

    def test_windows_argv_selection(self):
        posix = bash_module._windows_shell_command(r"C:\Program Files\Git\bin\bash.exe", "echo hi")
        self.assertEqual(posix.argv, [r"C:\Program Files\Git\bin\bash.exe", "-c", "echo hi"])
        self.assertFalse(posix.stream_status)
        self.assertIsNone(posix.marker)
        self.assertIsNone(posix.cleanup)

        powershell = bash_module._windows_shell_command(_POWERSHELL, "echo hi")
        self.assertEqual(
            powershell.argv[:7],
            [
                _POWERSHELL,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ],
        )
        self.assertTrue(powershell.stream_status)
        self.assertTrue(powershell.marker.startswith(bash_module._WIN_COMPLETION_PREFIX))
        # A script file, so a cmdlet error names the user's own line instead of the
        # wrapper statements, and the wrapper must be removed after the reap.
        self.assertIsNotNone(powershell.cleanup)
        try:
            self.assertTrue(os.path.exists(powershell.argv[7]))
            with open(powershell.argv[7], "r", encoding="utf-8-sig", newline="") as handle:
                self.assertIn("echo hi", handle.read())
        finally:
            bash_module.shutil.rmtree(powershell.cleanup, ignore_errors=True)

        cmd = bash_module._windows_shell_command(_CMD, "echo hi")
        self.assertEqual(cmd.argv[:3], [_CMD, "/d", "/c"])
        self.assertTrue(cmd.stream_status)
        self.assertIsNotNone(cmd.cleanup)
        try:
            self.assertTrue(os.path.exists(cmd.argv[3]))
            with open(cmd.argv[3], "r", newline="") as handle:
                self.assertIn("%ERRORLEVEL%", handle.read())
        finally:
            self.assertIsNotNone(cmd.cleanup)
            bash_module.shutil.rmtree(cmd.cleanup, ignore_errors=True)

    def test_stream_status_parsing(self):
        self.assertEqual(bash_module._parse_stream_status(b" 3"), 3)
        self.assertEqual(bash_module._parse_stream_status(b" 0\r"), 0)
        self.assertEqual(bash_module._parse_stream_status(b" -1\r"), -1)
        self.assertIsNone(bash_module._parse_stream_status(b""))
        self.assertIsNone(bash_module._parse_stream_status(b" nope"))

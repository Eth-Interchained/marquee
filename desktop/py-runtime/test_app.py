"""
Tests for the runtime's pure logic.

    .venv/bin/python -m unittest discover -s . -p 'test_*.py' -v

Deliberately stdlib-only: adding pytest to a runtime that gets bundled by
PyInstaller means another dependency in the shipped executable for no gain.
"""

from __future__ import annotations

import sys
import unittest

import app
import winpty_session


class PortResolution(unittest.TestCase):
    """The packaged executable is started as `jenny --port N` by the vendored
    orchestrator, while dev mode drives uvicorn and passes JENNY_PORT. Both
    have to work, and argv has to win, or a future change to one of them
    breaks packaging silently."""

    def test_argv_forms(self) -> None:
        self.assertEqual(app._port_from_argv(["--port", "4321"]), 4321)
        self.assertEqual(app._port_from_argv(["--port=4321"]), 4321)
        self.assertEqual(app._port_from_argv(["-x", "--port", "18764", "-y"]), 18764)

    def test_argv_rejects_nonsense_rather_than_crashing(self) -> None:
        self.assertIsNone(app._port_from_argv([]))
        self.assertIsNone(app._port_from_argv(["--port"]))
        self.assertIsNone(app._port_from_argv(["--port", "notanumber"]))
        self.assertIsNone(app._port_from_argv(["--port", "0"]))
        self.assertIsNone(app._port_from_argv(["--port", "70000"]))

    def test_argv_beats_env_and_env_beats_default(self) -> None:
        self.assertEqual(app._resolve_port(["--port", "5001"], {"JENNY_PORT": "6002"}), 5001)
        self.assertEqual(app._resolve_port([], {"JENNY_PORT": "6002"}), 6002)
        self.assertEqual(app._resolve_port([], {"MARQUEE_PY_RUNTIME_PORT": "6003"}), 6003)
        self.assertEqual(app._resolve_port([], {}), 18764)


class ProgramList(unittest.TestCase):
    """The PTY may only launch a closed list — the page must never choose argv."""

    def test_closed_list(self) -> None:
        self.assertEqual(sorted(app.PROGRAMS), ["node", "python", "shell"])
        for argv in app.PROGRAMS.values():
            self.assertIsInstance(argv, list)
            self.assertTrue(argv and isinstance(argv[0], str))


class TokenRedaction(unittest.TestCase):
    """The runtime's stdout is forwarded to a file on disk by the supervisor,
    so a token must never survive a log line."""

    def test_filter_scrubs_token_in_msg_and_args(self) -> None:
        import logging

        f = app._RedactToken()
        record = logging.LogRecord("x", logging.INFO, __file__, 1, "GET /ws/pty?token=SECRET&cols=80", None, None)
        f.filter(record)
        self.assertNotIn("SECRET", record.msg)
        self.assertIn("token=[redacted]", record.msg)

        record2 = logging.LogRecord("x", logging.INFO, __file__, 1, "%s", ("?token=SECRET",), None)
        f.filter(record2)
        self.assertNotIn("SECRET", str(record2.args))

    def test_uvicorn_access_logger_is_disabled(self) -> None:
        import logging

        self.assertTrue(logging.getLogger("uvicorn.access").disabled)


class WindowsBackend(unittest.TestCase):
    def test_missing_pywinpty_is_reported_as_none_not_an_exception(self) -> None:
        # On POSIX pywinpty is not installed (and is not in requirements for
        # this platform), so this exercises the ImportError path the Windows
        # handler depends on to close with 4501 instead of crashing.
        if sys.platform == "win32":  # pragma: no cover
            self.skipTest("pywinpty is expected to be importable on Windows")
        self.assertIsNone(winpty_session.load_pty_process())

    def test_close_codes_are_distinct_and_in_the_application_range(self) -> None:
        for code in (winpty_session.CLOSE_NO_PYWINPTY, winpty_session.CLOSE_SPAWN_FAILED):
            self.assertGreaterEqual(code, 4000)
            self.assertLessEqual(code, 4999)
        self.assertNotEqual(winpty_session.CLOSE_NO_PYWINPTY, winpty_session.CLOSE_SPAWN_FAILED)

    def test_the_install_hint_names_the_fix(self) -> None:
        self.assertIn("pywinpty", winpty_session.INSTALL_HINT)
        self.assertIn("requirements.txt", winpty_session.INSTALL_HINT)


if __name__ == "__main__":
    unittest.main()

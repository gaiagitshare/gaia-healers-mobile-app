# -*- coding: utf-8 -*-
"""A throwaway copy of the live database, with the real API in front of it.

Most of these suites were written against http://127.0.0.1:8002 — the API that
is actually serving the conference — because that is the quickest thing to
point at and because they mostly read. Then one of them printed a badge against
a real attendee, and it took a print report built two weeks later to notice
thirty-seven stickers that never came out of a printer and one person's card
switched on months before she arrives.

The answer is not "be careful in tests". It is to make the live database an
awkward thing to reach from one: a suite asks for a testbed, gets its own copy
with its own API on its own port, and can then write whatever it likes.

    import testbed
    BASE, DB = testbed.start()

The copy, the server and the temporary directory are all removed when the
process exits, including when it exits by failing.
"""
import atexit
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_DB = os.path.join(HERE, "event.db")

_beds = []


class Testbed(object):
    """One copy of the database with one API serving it."""

    def __init__(self, base, db, proc, workdir):
        self.base = base
        self.db = db
        self._proc = proc
        self._workdir = workdir

    def stop(self):
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except Exception:
                self._proc.kill()
            self._proc = None
        shutil.rmtree(self._workdir, ignore_errors=True)


def _free_port():
    """A port the OS just told us is free, so two suites can run at once."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start(wait_seconds=40):
    """Copy the live database, serve it, and return (base_url, db_path).

    The copy is a plain file copy rather than sqlite3.backup() on purpose: a
    suite wants the database exactly as it sits on disk, including anything a
    previous suite has just committed to it.
    """
    if not os.path.exists(LIVE_DB):
        raise RuntimeError("no database at %s" % LIVE_DB)
    workdir = tempfile.mkdtemp(prefix="testbed-")
    db = os.path.join(workdir, "event.db")
    shutil.copy(LIVE_DB, db)
    port = _free_port()
    env = dict(os.environ, DATABASE_URL="sqlite:///" + db)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=HERE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if proc.poll() is not None:
            shutil.rmtree(workdir, ignore_errors=True)
            raise RuntimeError("the testbed API exited before it was ready")
        try:
            urllib.request.urlopen(base + "/events", timeout=2)
            break
        except urllib.error.HTTPError:
            break                                  # 401 means it is listening
        except Exception:
            time.sleep(0.25)
    else:
        proc.terminate()
        shutil.rmtree(workdir, ignore_errors=True)
        raise RuntimeError("the testbed API never came up on %s" % base)

    # Several suites also reach the ORM directly -- SessionLocal, main._helpers
    # -- and that would still open the live file. Point this process at the copy
    # too, and rebind the engine if database has already been imported, so it
    # does not matter whether the suite imported it above this line or below.
    os.environ["DATABASE_URL"] = "sqlite:///" + db
    if "database" in sys.modules:
        import importlib
        importlib.reload(sys.modules["database"])

    bed = Testbed(base, db, proc, workdir)
    _beds.append(bed)
    return base, db


@atexit.register
def _cleanup():
    for bed in _beds:
        bed.stop()
